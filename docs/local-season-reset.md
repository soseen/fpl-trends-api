# Local season reset

Use this runbook when the FPL API has switched to a new season and the local
database needs the new teams, players, fixtures, events, and My Trends data.

The normal `npm run populate` job is season-aware and should reset the database
automatically when the season derived from FPL's first event differs from
`app_metadata.current_season`. The manual reset below is the predictable clean
start for a developer database, or the fallback when automatic detection did
not run.

## Before you reset

`npm run reset-season` is destructive. It operates on the database selected by
`DATABASE_URL` in `.env`, so confirm that it points to the intended local
PostgreSQL database before continuing. Do not run the local procedure against a
production connection.

The reset preserves the outgoing bulk datasets in `season_archives` when a
current season is recorded. It then removes live season data, cached raw FPL
JSON, My Trends manager data, derived manager read models, and manager ingest
cursors. The archive itself is retained.

Make sure PostgreSQL is running, dependencies are installed, and the FPL API is
available. Apply migrations before the reset so every table expected by the
cleanup exists:

```powershell
npm install
npm run migrate
```

`npm install` can be skipped when `node_modules` already matches the lockfile.

## Recommended local sequence

From the API repository root:

```powershell
# Optional: record the current state before deleting it.
npm run check-local-state

# Archive the outgoing bulk data, clear all live season data and reset
# season/manager-ingest metadata.
npm run reset-season

# Fetch the new bootstrap payload and every player summary, then populate
# teams, events, players, fixtures, player history, and team history.
npm run populate

# Seed/refresh the manager sample used by My Trends.
npm run populate-managers

# Verify the resulting season, gameweeks, sample, and derived tables.
npm run check-local-state
```

The essential bulk-data commands are:

```powershell
npm run reset-season
npm run populate
```

Run `npm run populate-managers` as well when My Trends needs manager comparison,
range-rank, team-impact, or transfer analytics. One invocation is bounded and
may not complete all sampling walks. Re-run it until `npm run check-local-state`
reports the desired coverage and `manager_sample_gw_finalized` is complete for
the current finished gameweek. The normal manager-ingest cron can do these
subsequent passes instead.

## What each command does

### `npm run reset-season`

1. Archives the outgoing season's bulk endpoint payloads when possible.
2. Clears player, fixture, history, team, team-history, and event tables.
3. Clears all season-scoped My Trends manager tables and derived read models.
4. Clears manager sampling cursors and season-closure metadata.
5. Deletes cached `src/data/raw_bootstrap_static.json` and
   `src/data/raw_footballers.json` files.
6. Removes `app_metadata.current_season`, allowing the next populate to detect
   and store the current FPL season.

### `npm run populate`

1. Downloads the current `bootstrap-static` response.
2. Detects and records the current season.
3. Downloads individual player summaries.
4. Populates teams, events, the updated player list, fixtures, player history,
   and team history.

This is the command that supplies the new player list and core Trends data.

### `npm run populate-managers`

Builds the stratified manager sample and the derived tables used by My Trends.
It is intentionally incremental and rate-limited, so multiple runs may be
needed. If no gameweek is active or finished yet, it exits without ingesting
managers; run it again once GW1 is active or finished.

### `npm run check-local-state`

Performs a read-only readiness check. Confirm at minimum that:

- `current_season` is the new season.
- The `events` table contains the new schedule.
- The manager tables contain only current-season gameweeks.
- Manager sample finalization is complete when a gameweek has finished.

## Automatic path

For routine operation, this is usually enough:

```powershell
npm run populate
```

If the stored and API-derived seasons differ, populate archives the outgoing
bulk data, performs the same season cleanup, stores the new season, and then
continues with a fresh bulk ingest. Run `npm run populate-managers` separately
because manager sampling is not part of the bulk populate command.

## Start the API and smoke-test it

After the data checks pass:

```powershell
npm run dev
```

Check the endpoints used by the application:

- `GET http://localhost:3000/api/seasons`
- `GET http://localhost:3000/api/eventsData`
- `GET http://localhost:3000/api/footballersData`
- `GET http://localhost:3000/api/teamsData`

For My Trends, also query a valid current-season FPL entry through one of the
`/api/manager/:id/...` endpoints.

## Troubleshooting

- **Wrong or missing season after populate:** inspect the first event in FPL's
  bootstrap response. Season detection needs a valid deadline. Do not rerun a
  destructive reset until the API is publishing the new schedule.
- **Reset refuses to archive:** the outgoing season is recorded but its bulk
  dataset is empty. Restore/populate the outgoing data if it must be archived,
  or investigate the metadata before deciding to remove it manually.
- **Populate stops midway:** fix the reported network or database error, then
  rerun `npm run populate`; table writes are designed to be idempotent.
- **My Trends is empty:** run `npm run populate-managers` after a gameweek is
  active or finished, and repeat it until the readiness check shows sufficient
  coverage.
- **Schema/table errors:** run `npm run migrate`, then retry.
