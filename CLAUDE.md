# fpl-trends-api — Backend Context

Node.js backend for FPL Trends. Fetches Fantasy Premier League data, stores in PostgreSQL, serves via REST API.

## Stack

Node.js 22+ (LTS), TypeScript 5.7, Express 4.21, Prisma 6.2, PostgreSQL, Axios, Helmet, Compression, CORS.

## Tooling

- **TypeScript**: `tsconfig.json` — `target: ES2022`, `module: Node16`, `moduleResolution: Node16`, strict mode with `noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`.
- **ESLint**: Flat config (`eslint.config.js`) — ESLint 9 with `typescript-eslint` type-checked rules, Prettier integration, consistent type imports enforced, floating promises caught.
- **Prettier**: Integrated via eslint-plugin-prettier. 2-space indent, semicolons, double quotes.

## Project Structure

```
src/
├── server.ts                          — Express app, routes, middleware, CORS config
├── fetch.ts                           — HTTP helpers for FPL API calls
├── file.helpers.ts                    — File path constants for cached JSON data
├── types.ts                           — Shared TypeScript types
├── utils.ts                           — General utilities (delay)
├── bootstrapStatic/
│   ├── fetchBootstrapStatic.ts        — Fetches bulk FPL data (teams, events, players list)
│   └── types.ts                       — Bootstrap response types
├── database/
│   ├── client.ts                      — Prisma client singleton
│   ├── populateDatabase.ts            — Orchestrates full data refresh (season-aware)
│   ├── seasonManager.ts               — Season detection, wipe, and reset logic
│   ├── resetSeason.ts                 — Manual season reset script (npm run reset-season)
│   ├── insertFootballers.ts           — Upserts player data into footballers table
│   ├── insertFootballersFixtures.ts   — Upserts upcoming fixtures per player
│   ├── insertFootballersHistory.ts    — Upserts match-by-match history per player
│   ├── insertTeams.ts                 — Upserts team data
│   └── insertTeamHistory.ts           — Aggregates + inserts team-level stats per GW
├── events/
│   ├── getEvents.ts                   — API handler for /api/eventsData (HAS BUG — queries teams not events)
│   └── insertEvents.ts               — Upserts gameweek event data
├── footballers/
│   ├── fetchFootballers.ts            — Batch-fetches individual player summaries from FPL API
│   ├── getAllFootballersData.ts        — API handler for /api/footballersData
│   ├── types.ts                       — Footballer-specific types
│   └── utils.ts                       — Footballer utilities
├── teams/
│   └── getTeamsData.ts                — API handler for /api/teamsData
├── data/                              — Cached API responses (gitignored)
│   ├── raw_bootstrap_static.json      — Cached FPL bootstrap response
│   └── raw_footballers.json           — Cached player summaries
└── [DEPRECATED legacy files]
    ├── fetchSampleData.ts             — Dead: old manager sampling workflow
    ├── fetchAllRawData.ts             — Dead: old manager data fetching
    ├── processRawData.ts              — Dead: old data cleaning/blacklisting
    └── sampling.ts                    — Dead: old sampling utilities
prisma/
├── schema.prisma                      — Database schema (7 models incl. app_metadata)
└── migrations/                        — Prisma migrations
```

## Database Schema

### app_metadata
Key-value store for application state. Currently stores `current_season` (e.g. "2025-26") for season change detection.

### footballers
Primary player table. ~100+ columns. Key fields: `id`, `web_name`, `first_name`, `second_name`, `team_id`, `now_cost`, `total_points`, `goals_scored`, `assists`, `expected_goals`, `expected_assists`, `expected_goal_involvements`, `expected_goals_conceded`, per-90 variants, ICT index fields with ranks, `form`, `status`, `selected_by_percent`, `minutes`, `starts`.

Relations: `teams` (belongsTo via team_id), `history` (hasMany), `footballer_fixtures` (hasMany). Cascade delete on children.

### history
Composite PK: `(footballer_id, fixture_id)`. Fields: `total_points`, `goals_scored`, `assists`, `clean_sheets`, `bonus`, `bps`, `expected_goals`, `expected_assists`, `expected_goals_conceded`, `expected_goal_involvements`, `opponent_team`, `was_home`, `round`, `kickoff_time`, `minutes`, `value`, `selected`, `transfers_in`, `transfers_out`.

### footballer_fixtures
Fields: `id`, `footballer_id`, `fixture_id`, `team_h`, `team_a`, `team_h_score`, `team_a_score`, `difficulty`, `is_home`, `kickoff_time`, `event`, `finished`, `minutes`.

### teams
Fields: `id`, `code`, `name`, `short_name`, `strength`, `strength_overall_home/away`, `strength_attack_home/away`, `strength_defence_home/away`, `points`, `position`, `played`, `win`, `draw`, `loss`, `form`.

Relations: `footballers` (hasMany), `team_history` (hasMany).

### team_history
Composite PK: `(team_id, round)`. Fields: `teamXGC` (max xGC across players), `teamXGS` (sum of player xG), `goals`, `goals_conceded`.

### events
Fields: `id`, `name`, `finished`, `is_current`, `is_previous`, `is_next`, `average_entry_score`, `highest_score`, `most_selected`, `most_transferred_in`, `top_element`, `most_captained`, `deadline_time_epoch`.

## Season Management

The app tracks the current FPL season (e.g. "2025-26") in the `app_metadata` table.

### How it works

1. On each `npm run populate`, the system fetches bootstrap data from the FPL API
2. It derives the season from the first event's deadline year (e.g. Aug 2025 → "2025-26")
3. It compares against the stored season in `app_metadata`
4. **If the season has changed**: all 6 game data tables are truncated, cached JSON files are deleted, and the new season is stored — then a fresh populate runs
5. **If same season**: normal upsert-based population continues

### Manual reset

`npm run reset-season` wipes all game data and clears the season identifier. Run `npm run populate` after to re-fetch.

## API Endpoints

```
GET /api/footballersData      — All players with team, history, fixtures (Prisma includes)
GET /api/teamsData            — All teams with team_history
GET /api/totalPlayersCount    — { totalPlayers: number }
GET /api/eventsData           — Gameweek events (BUG: returns teams data)
GET /api/populate             — Triggers full data refresh from FPL API (season-aware)
```

No authentication. CORS allows `https://fpltrends.app`, `https://www.fpltrends.app`, and `http://localhost:5000` (dev).

## FPL API Fetching

Two external endpoints used:
- `https://fantasy.premierleague.com/api/bootstrap-static/` — teams, events, player list
- `https://fantasy.premierleague.com/api/element-summary/{id}/` — per-player details

Batching: 32 players/batch, 60ms delay between batches, 3 retries with exponential backoff (500ms + retries * 2000ms). Raw responses cached to JSON files in `src/data/`.

All database inserts use Prisma `upsert` (insert or update by code/ID).

## Team History Aggregation Logic

In `insertTeamHistory.ts`:
- **teamXGS**: Sum of all player `expected_goals` in that round
- **teamXGC**: Maximum `expected_goals_conceded` across all players (team-level defensive exposure)
- **goals**: Sum of all player `goals_scored` in round
- **goals_conceded**: Maximum `goals_conceded` by any player

## Environment Variables

```
DATABASE_URL    — PostgreSQL connection string (required)
NODE_ENV        — "development" or "production" (controls CORS)
PORT            — Server port (default: 3000)
```

## Commands

```bash
npm run dev          — Start with tsx (hot reload)
npm run build        — tsc + migrate + populate
npm run migrate      — npx prisma migrate deploy
npm run populate     — Fetch FPL data and insert into DB (detects season changes)
npm run reset-season — Manual full data wipe (run populate after)
npm start            — node dist/server.js
npm run lint         — ESLint check
npm run lint:fix     — ESLint auto-fix
```

## Known Issues

1. `/api/eventsData` handler in `src/events/getEvents.ts` queries `prisma.teams` instead of `prisma.events`
2. No scheduled/automatic data refresh — populate is manual only
3. Database credentials committed in `.env` file
4. No rate limiting on API endpoints
5. No health check endpoint
6. Legacy dead files (`fetchSampleData.ts`, `fetchAllRawData.ts`, `processRawData.ts`, `sampling.ts`) are emptied but not yet deleted from the repo
