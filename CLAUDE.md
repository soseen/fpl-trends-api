# fpl-trends-api — Backend Context

Node.js backend for FPL Trends. Fetches Fantasy Premier League data, stores in PostgreSQL, serves via REST API.

> **For full operational detail** (server bootstrap, deploy, season runbook, troubleshooting), read [`Readme.md`](./Readme.md). This file is the architectural/code-level reference.

> **Development mode.** This app is still pre-stable. Schemas, endpoints,
> and pipelines are all fair game to delete or restructure. Wiping the DB
> (`npm run reset-season` then `populate`) is a routine operation, not a
> recovery scenario — feel free to drop tables, change column semantics,
> or rip out features when a cleaner design appears. No data migrations
> for legacy state, no compat shims for old API consumers.

## Production at a glance

- Runs as `pm2` process `fpl-trends-api` on port 3000 (Hetzner CX23 at `91.98.145.120`, Ubuntu 24.04, deploy user `deploy`)
- nginx terminates TLS and reverse-proxies `/api/*` from `https://fpltrends.live` to `127.0.0.1:3000`
- PostgreSQL 16 on the same box, db `fpl-trends-db`, user `fpl`, local Unix socket
- Repo at `~/fpl-trends-api`, env at `~/fpl-trends-api/.env`
- System cron triggers populate (no in-process scheduler)
- No backups — rebuild-on-failure stance

### Quick ops commands

```bash
ssh deploy@91.98.145.120
pm2 logs fpl-trends-api --lines 100
pm2 restart fpl-trends-api

# Deploy (one-liner — handles pull, install, build, migrate, pm2 restart):
cd ~/fpl-trends-api && npm run deploy

# Manual populate:
cd ~/fpl-trends-api && npm run populate

# First-time setup on a new server:
cd ~/fpl-trends-api && npm run bootstrap   # tsc + migrate + populate

# New-season reset (if auto-detect fails):
cd ~/fpl-trends-api && npm run reset-season && npm run populate && pm2 restart fpl-trends-api

# Backfills (one-off, idempotent):
npm run backfill-cumulative              # required after schema migrations that add cumulative cols
npm run backfill-stratum-captain-picks   # optional; populate cron does the same at end of each tick
npm run backfill-picks                   # one-off historic catch-up of manager_picks (heavy FPL load)

# Diagnostic — prints row counts for every My Trends-relevant table:
npm run check-local-state
```

## Architectural notes

1. **dotenv is loaded explicitly.** Prisma CLI auto-loads `.env`, but `tsx` and compiled `node` don't. `server.ts`, `populateDatabase.ts`, and `resetSeason.ts` each have `import "dotenv/config"` at the top. New tsx/node entrypoints need the same line or they'll fail with `Environment variable not found: DATABASE_URL`.

2. **`npm run build` is compile-only** (`tsc`). First-time setup uses `npm run bootstrap` (`tsc && migrate && populate`).

3. **Populate is idempotent.** Everything is upsert-by-id; half-finished runs are safe to retry.

4. **CORS is env-driven.** `ALLOWED_ORIGINS` env var (comma-separated). Defaults to the production domains.

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
│   ├── getEvents.ts                   — API handler for /api/eventsData
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

### Bulk data (cached globally via `cachedJson`, invalidated on populate)

```
GET /api/health               — Liveness + DB ping; 200 if DB reachable, 503 otherwise
GET /api/footballersData      — All players with team, history, fixtures (Prisma includes)
GET /api/teamsData            — All teams with team_history
GET /api/totalPlayersCount    — { totalPlayers: number }
GET /api/eventsData           — Gameweek events
GET /api/populate             — Triggers full data refresh from FPL API (season-aware)
                                Requires `Authorization: Bearer $ADMIN_TOKEN`. 401 on bad/missing
                                token, 503 if ADMIN_TOKEN is unset on the server.
```

### My Trends (per-(entry, range), cached via `cachedManagerJson`)

All four take an FPL entry id; range-rank/comparison/team-impact also
take `?start=N&end=M` GW range params. Wrapped in a 5-minute TTL'd LRU
keyed on `(endpoint, entryId, startGw, endGw)`, with in-flight de-dup so
duplicate concurrent requests share one execution.

```
GET /api/manager/:id/summary       — FPL summary (overall rank, total points, name)
GET /api/manager/:id/trajectory    — per-GW points + transfers + hits across the season
GET /api/manager/:id/range-rank    — estimated GW-range rank vs. sample (Bernoulli urn)
GET /api/manager/:id/comparison    — user vs. active-sample + top-10k averages for the range
GET /api/manager/:id/team-impact   — per-player rank attribution + rank killers
```

Heavy reads in comparison/team-impact are served from `manager_cumulative`
(running totals, range = subtraction) and `stratum_captain_picks_gw`
(pre-aggregated captain rates). User picks are resolved via the shared
`src/managers/resolvePicks.ts` (DB cache + FPL fallback, in-flight de-dup
across endpoints).

Read endpoints are intentionally unauthenticated — data served is public FPL data and the app has no user accounts. Privileged routes (currently `/api/populate`, guarded by `src/middleware/requireAdminToken.ts`) require `Authorization: Bearer $ADMIN_TOKEN`. CORS origins are configured via the `ALLOWED_ORIGINS` env var (comma-separated). Defaults to `https://fpltrends.live, https://www.fpltrends.live`. In dev (`NODE_ENV !== "production"`), `http://localhost:5000` is also allowed automatically.

All `/api/*` routes are rate-limited per IP via `express-rate-limit` (`src/middleware/rateLimit.ts`) — 60 requests per rolling 60s window. Over the limit returns `429` with `RateLimit-*` headers (IETF draft-8). Express is configured with `trust proxy = "loopback"` so the limiter sees the real client IP from nginx's `X-Forwarded-For`, but rejects spoofed `X-Forwarded-For` from non-local sources. The frontend's normal request volume (≤10 on app init, near-zero after React Query caches) is well under the limit.

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
ADMIN_TOKEN     — Bearer token required by /api/populate. If unset, the endpoint
                  returns 503 (fail-closed). Generate with `openssl rand -hex 32`.
```

## Secrets handling

Secrets (DB password, `ADMIN_TOKEN`) live in plaintext in `~/fpl-trends-api/.env` on the production box. This is deliberate, not an oversight. The threat model:

- **Shell access (root or `deploy`)** — encryption-at-rest doesn't help; the running pm2 process needs the secret in memory, so anyone who can `cat /proc/<pid>/environ` already has it. SSH is hardened (key-only, root login disabled).
- **Read-only FS leak** (path traversal, accidental `cp`, world-readable file) — mitigated by `chmod 600 ~/fpl-trends-api/.env`, owned by `deploy`. Re-apply after every edit.
- **Backup / snapshot leak** — N/A. The Hetzner box has no automated backups (rebuild-on-failure stance) and no snapshot regimen.
- **Source / repo leak** — `.env` is gitignored; nothing committed.

Re-evaluate this stance if any of the following changes: backups are introduced, the box is shared with additional operators, or the box gets snapshotted regularly. Likely path forward at that point: `age`-encrypted `.env.age` in the repo, decrypt on the server using a key in `~/.config/age/keys.txt`. See [`Readme.md`](./Readme.md) for the rotation runbook.

## Commands

```bash
npm run dev                            — Start with tsx (no auto-reload — restart manually after edits)
npm run build                          — prisma generate + tsc
npm run bootstrap                      — generate + tsc + migrate + populate (first-time setup)
npm run migrate                        — npx prisma migrate deploy
npm run populate                       — Fetch FPL bulk data into DB (season-aware)
npm run populate-managers              — Walk standings + ingest manager histories (cron job entrypoint)
npm run reset-season                   — Wipe all season data (run populate after)
npm run backfill-cumulative            — Bulk-build manager_cumulative from manager_history
npm run backfill-stratum-captain-picks — Rebuild stratum_captain_picks_gw out-of-band
npm run backfill-picks                 — One-off historic catch-up of manager_picks (heavy FPL load)
npm run check-local-state              — Print row counts for every My Trends-relevant table
npm start                              — node dist/server.js
npm run lint                           — ESLint check
npm run lint:fix                       — ESLint auto-fix
```

## Known Issues

1. No scheduled/automatic data refresh inside the Node process — relies on system cron in production.
