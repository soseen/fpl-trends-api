# fpl-trends-api - Codex Context

Node.js backend for FPL Trends. It fetches Fantasy Premier League data
from the official FPL API, stores it in PostgreSQL through Prisma, and
serves REST endpoints consumed by `fpl-trends-app`.

This app is pre-stable. Schema changes, endpoint changes, DB wipes, and
season resets are acceptable when they simplify the product. Do not add
legacy compatibility shims unless explicitly asked.

## Stack And Tooling

- Node 22+, TypeScript 5.7, Express 4, Prisma 6.2, PostgreSQL, Axios
- ESM project (`"type": "module"`), compiled output in `dist/`
- Strict TypeScript with `noUncheckedIndexedAccess`,
  `noPropertyAccessFromIndexSignature`, `noImplicitOverride`
- ESLint 9 flat config with type-checked TypeScript rules and Prettier
- Prettier style: 2 spaces, semicolons, double quotes

Common commands:

```bash
npm run dev
npm run build
npm run lint
npm run lint:fix
npm run migrate
npm run populate
npm run populate-managers
npm run reset-season
npm run check-local-state
```

`npm run build` runs `prisma generate && tsc`. First setup uses
`npm run bootstrap`, which also migrates and populates.

Every tsx/node entrypoint that reads env vars must import
`dotenv/config` at the top. Prisma CLI loads `.env`; `tsx` and compiled
`node` do not.

## Main Structure

- `src/server.ts`: Express bootstrap, middleware, CORS, all API routes
- `src/cache/responseCache.ts`: global response cache and manager range
  cache with ETags, LRU cap, TTL, and in-flight de-duping
- `src/fetch.ts`: FPL API helper functions
- `src/bootstrapStatic/`: bootstrap-static fetching and types
- `src/footballers/`: player summary fetching and player API handler
- `src/teams/`: team API handler
- `src/events/`: gameweek event ingestion and API handler
- `src/database/`: Prisma client, populate orchestration, backfills,
  season reset, manager sample ingestion
- `src/managers/`: FPL manager fetchers, pick/transfer resolvers, range
  rank, comparison, team impact, transfer impact, rate-limit governor
- `prisma/schema.prisma`: database schema
- `prisma/migrations/`: Prisma migrations
- `src/data/`: cached raw FPL responses, gitignored

## API Surface

Bulk endpoints are cached globally until `populate` invalidates them:

- `GET /api/footballersData`: all footballers with `teams`,
  `history`, and `footballer_fixtures`
- `GET /api/teamsData`: all teams with `team_history`
- `GET /api/totalPlayersCount`: total global FPL manager count
- `GET /api/eventsData`: gameweek events
- `GET /api/populate`: runs season-aware populate and clears response
  cache

Manager endpoints use FPL entry IDs, validate IDs/ranges, and cache
range responses for five minutes:

- `GET /api/manager/:id/summary`
- `GET /api/manager/:id/trajectory`
- `GET /api/manager/:id/range-rank?start=N&end=M`
- `GET /api/manager/:id/comparison?start=N&end=M`
- `GET /api/manager/:id/team-impact?start=N&end=M`
- `GET /api/manager/:id/transfers?start=N&end=M`

Use `cachedJson` for shared bulk responses and `cachedManagerJson` for
manager range responses. `invalidateCache()` is called after populate.

## Data And Season Model

The app fetches:

- `bootstrap-static/`: teams, events, player list, total player count
- `element-summary/{id}/`: individual player history and fixtures
- `entry/{id}/`, `entry/{id}/history/`, `entry/{id}/event/{gw}/picks/`,
  and `entry/{id}/transfers/`: manager analytics

Populate is designed to be idempotent. Inserts should generally be
upserts keyed by FPL IDs or composite natural keys.

Season detection lives in `src/database/seasonManager.ts`. On populate,
the app derives the FPL season from bootstrap event deadlines and compares
it to `app_metadata.current_season`. A season change truncates game data,
clears cached raw JSON, stores the new season, and repopulates. Manual
reset is `npm run reset-season` followed by `npm run populate`.

## Prisma Models To Know

Core FPL data:

- `footballers`: player table with FPL bootstrap fields, xG/xA/xGI/xGC,
  per-90 stats, ICT fields, status, costs, ownership, defensive
  contribution
- `history`: per-player per-fixture GW history, PK
  `(footballer_id, fixture_id)`
- `footballer_fixtures`: upcoming and completed fixture data per player,
  unique `(footballer_id, fixture_id)`
- `teams`: club metadata and strength ratings
- `team_history`: per-team per-round aggregate xGS/xGC/goals, unique
  `(team_id, round)`
- `events`: gameweek metadata
- `app_metadata`: key/value app state

Manager analytics:

- `manager_summary`: sampled manager identity/rank/stratum and transfer
  coverage flag
- `manager_history`: per-manager per-GW points, transfers, hits, bench
  points
- `manager_picks`: per-manager per-GW captain/vice/chip summary
- `manager_pick_elements`: lazy full XV for team-impact endpoints
- `manager_cumulative`: running manager totals by GW, used for fast range
  subtraction
- `manager_transfers`: full transfer history rows
- `stratum_captain_picks_gw`: pre-aggregated captain rates
- `stratum_gw_running_stats`: per-stratum running aggregate snapshots

Hot manager reads should prefer cumulative/pre-aggregated tables rather
than scanning `manager_history` or `manager_picks` on every request.

## Production Notes

- pm2 process: `fpl-trends-api`
- Port: `3000`
- CORS comes from `ALLOWED_ORIGINS`, with production defaults
  `https://fpltrends.live` and `https://www.fpltrends.live`
- In non-production, `http://localhost:5000` is also allowed
- `npm run deploy` on production runs pull, install, build, migrate, and
  pm2 restart
- Cron, not the server process, triggers recurring populate jobs

## Known Risks

- No authentication; all endpoints are public
- No endpoint-level rate limiting beyond manager fetch governance and
  response cache behavior
- Plaintext `.env` on server
- No production backups
- Schema and manager analytics are evolving; prefer clear invariants in
  comments when touching cumulative/range logic

