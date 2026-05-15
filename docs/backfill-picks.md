# `backfill-picks` — fill historical captain picks

A **long-running one-off** script that fetches captain choices and active chips for every `(sampled manager, finished GW)` pair the database is missing. Powers the captain-bonus and most-captained rows in the My Trends comparison table.

> Plan ~6–9 hours wall-clock. Always launch with `nohup` so you can close the terminal.

## Why this exists

Routine ingestion (`populate-managers`) only writes the **latest finished GW's** picks per manager — that keeps each cron tick predictable (~5,000 extra FPL calls per run). Historical depth (every prior GW for every existing manager) needs a dedicated pass, which is what this script is.

Without picks data, the comparison table's captain-bonus, most-captained, and captain-related chip rates show `—` for the average and top-10k columns.

## What it does, in plain terms

1. Reads the latest finished GW from `events`.
2. For each stratum (1, then 2, then 3):
   - Runs SQL to find every `(entry_id, gw)` pair where the manager exists in our sample but `manager_picks` doesn't have a row.
   - Walks the missing pairs in batches of 8 concurrent fetches.
   - For each pair: hits `/entry/{id}/event/{gw}/picks/`, extracts captain + vice + multiplier + active chip, upserts into `manager_picks`.
   - Logs progress every 500 pairs.
3. Exits when all three strata are done (or aborts if rate-limit governor gives up after 3 consecutive errors — re-run to resume).

Stratum order matters: stratum 1 (top-10k census) goes first so the comparison table's top-10k column lights up within ~30–60 minutes, while stratums 2 and 3 keep filling in the background.

## How to invoke it

### Standard (background, detached)

This is the only way you should run this in production.

```bash
ssh deploy@91.98.145.120
cd ~/fpl-trends-api
nohup npm run backfill-picks > backfill-picks.log 2>&1 &
disown
```

What each piece does:

- `nohup` — survive SIGHUP when the SSH session ends.
- `> backfill-picks.log 2>&1` — capture stdout _and_ stderr to a file (otherwise they'd vanish when your terminal closes).
- `&` — run in the background; you get your shell prompt back immediately.
- `disown` — extra belt-and-braces; removes the job from the shell's job table.

You can now safely close the terminal.

### Watch progress later

```bash
ssh deploy@91.98.145.120

# Follow the log live:
tail -f ~/fpl-trends-api/backfill-picks.log

# Or just the last few lines:
tail -50 ~/fpl-trends-api/backfill-picks.log

# Confirm the process is still alive:
pgrep -fl backfillPicks
```

What healthy output looks like:

```
[backfillPicks] stratum 1: 245612 missing (manager, gw) pairs.
[backfillPicks] stratum 1: 500 done, 0 failed, 245112 remaining
[backfillPicks] stratum 1: 1000 done, 0 failed, 244612 remaining
...
[backfillPicks] stratum 1: complete (245598 done, 14 failed).
[backfillPicks] stratum 2: 432840 missing (manager, gw) pairs.
[backfillPicks] stratum 2: 500 done, 0 failed, 432340 remaining
...
[backfillPicks] all strata complete: 925k done, 387 failed (governor aborted: false).
```

A few hundred failures across the whole run is normal — deleted accounts, transient timeouts, occasional 502s from FPL.

## Stopping it

If you need to stop the backfill mid-flight:

```bash
ssh deploy@91.98.145.120
pgrep -fl backfillPicks                   # find the PID
kill <PID>                                # graceful stop
# After a few seconds, confirm:
pgrep -fl backfillPicks                   # should be empty
```

The script is fully resumable — relaunch with the same `nohup ... &` command and it picks up where it left off (every `(entry_id, gw)` is a primary-key upsert, and the missing-pairs query naturally excludes rows already written).

## Inspecting coverage

```sql
-- Picks coverage per stratum: how many (manager, gw) pairs do we have
-- versus how many we expect for the current finished GW range?
WITH finished AS (
  SELECT MAX(id) AS gw FROM events WHERE finished = true
),
expected AS (
  SELECT ms.stratum,
         COUNT(*) * (SELECT gw FROM finished) AS pairs
  FROM manager_summary ms
  GROUP BY ms.stratum
)
SELECT e.stratum,
       COUNT(mp.entry_id) AS have,
       e.pairs AS want,
       ROUND(100.0 * COUNT(mp.entry_id) / NULLIF(e.pairs, 0), 1) AS pct
FROM expected e
LEFT JOIN manager_summary ms ON ms.stratum = e.stratum
LEFT JOIN manager_picks mp ON mp.entry_id = ms.entry_id
GROUP BY e.stratum, e.pairs
ORDER BY e.stratum;
```

Top-10k coverage hits 100% first (around the 30–60 min mark). Stratum 3 finishes last.

```sql
-- Sample a manager's picks to spot-check the data:
SELECT mp.gw, f.web_name AS captain, mp.captain_multiplier, mp.active_chip
FROM manager_picks mp
LEFT JOIN footballers f ON f.id = mp.captain_element
WHERE mp.entry_id = <some_id>
ORDER BY mp.gw;
```

## How long does it take?

Depends on sample size — roughly:

- ~25,000 sampled managers × ~33 finished GWs ≈ **825,000 fetches**.
- The rate-limit governor caps sustained throughput at ~25 req/s.
- Total: **~9 hours** at the start of a season; less if some picks already exist (e.g. you re-deploy partway through).

The picks-fetch path is bottlenecked on FPL API throughput, not our DB or the governor's safety margins.

## When to run it

- **Once, after the schema migration that adds `manager_picks`** (commit `023c25e` includes the migration).
- **Once after `npm run reset-season`** — the migration leaves the table; reset-season truncates it. Run picks backfill to refill.
- **Optionally after expanding the sample** — e.g. you bumped `STRATUM_C_ID_MAX` in [`populateManagers.ts`](../src/database/populateManagers.ts) and want to retroactively backfill picks for newly-eligible managers (the cron's inline ingestion will only catch up their _current-GW_ picks).

## When NOT to run it

- During the first GW of a new season — there's nothing to backfill until at least one GW finishes.
- While `populate-managers` is mid-tick? It's actually fine — both honor the same governor pacing and they're independent processes (no shared lockfile). They'll just split the FPL API budget between them temporarily.

## Safety rails

- **Idempotent missing-pairs query** — re-running after interruption picks up only the still-missing pairs.
- **Adaptive backoff** — same `RateLimitGovernor` as `populate-managers`.
- **Per-error retry** with `MAX_RETRIES = 3` per `(entry_id, gw)` before that pair is marked failed (logged and skipped — the script moves on, doesn't stall).

## Verification

After full completion, the My Trends comparison table should show real numbers (no `—`) for:

- **Captain bonus** — You / Average / Top 10k all populated
- **Most captained** — player names in all three columns
- **Wildcards / Free hits / Bench boosts** — the **Top 10k** rate column especially. The overall Average column always works because it falls back to `events.chip_plays`.

## Related files

- [`src/database/backfillPicks.ts`](../src/database/backfillPicks.ts) — the script
- [`src/managers/fetchPicks.ts`](../src/managers/fetchPicks.ts) — FPL `picks/` wrapper + `summarizePicks` helper
- [`src/managers/getManagerComparison.ts`](../src/managers/getManagerComparison.ts) — consumer of the data (captain-bonus SQL, most-captained query)
- [`prisma/migrations/20260428120000_picks_and_transfers/`](../prisma/migrations/20260428120000_picks_and_transfers/migration.sql) — schema migration
