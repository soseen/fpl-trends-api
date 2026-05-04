# `manager_cumulative` — pre-aggregated range totals + sample stats

A derived table that backs the My Trends endpoints' hot read paths.
Driven by [`src/database/populateManagers.ts`](../src/database/populateManagers.ts)
(steady-state, per-entry rebuild on every visit) and
[`src/database/backfillManagerCumulative.ts`](../src/database/backfillManagerCumulative.ts)
(one-off bulk bootstrap from `manager_history`).

> Not a cron, not a long-running script — it's a derived table. Backfill
> once after a schema migration that adds new cumulative columns; the
> populate cron then maintains it forever.

## Why this exists

`getRangeRank.stratumCounts`, `getTeamImpact.computeRankPerPoint`, and
`getManagerComparison.sampleStratumAggregates` all want the same thing:
"across the stratum, what's each sampled manager's stat total over GWs
X–Y?". Done naively that's a `GROUP BY entry_id` over `manager_history`
— for stratum 3 across a full season, ~21M rows scanned per query, 8–10 s
on the prod box.

`manager_cumulative` stores per-(entry, gw) running totals. Any range
total is a subtraction:

```
range_total[entry] = cumulative[entry, end_gw] − cumulative[entry, start_gw − 1]
```

Two indexed lookups per entry, no GROUP BY. The full ~625k S3 sample
fits in the query budget, dropping range-rank std-dev to ~±8k for
typical S3 users.

The same pattern extends to all the manager-side aggregates the
comparison endpoint needs: `cumulative_transfers`, `cumulative_hits_cost`,
`cumulative_bench`, `cumulative_captain_bonus`, `gws_played`, plus
per-half boolean flags for chip plays (`chip_wildcard_h1/h2`, etc.) and
data-coverage flags (`has_transfers`, `has_hits`, `has_bench`).

## What it does, in plain terms

1. **Schema** (see `prisma/schema.prisma`): primary key `(entry_id, gw)`,
   `stratum` and `rejected_reason` denormalised from `manager_summary` so
   the read path needs no join. Three indexes:
   - `(stratum, gw)` — for c_start (`WHERE stratum = X AND gw < Y` as a
     contiguous range).
   - `(stratum, rejected_reason, gw)` — same for the active-only c_start
     in `computeRankPerPoint` and `sampleStratumAggregates`.
   - `(stratum, entry_id, gw DESC)` — for c_end (`DISTINCT ON (entry_id)
     ORDER BY entry_id, gw DESC` over a stratum partition). Without this
     index PG picks the primary key `(entry_id, gw)` and post-filters
     `stratum`, scanning the full table and Incremental-Sorting 12M+ rows.

2. **Per-entry rebuild** (steady state): every time
   `populateManagers.processEntry` upserts an entry's history rows, it
   calls `rebuildCumulativeForEntry`. That function `DELETE`s all this
   entry's cumulative rows and re-inserts a fresh set in one
   window-function pass — joining `manager_picks` for chip flags and a
   correlated subquery to `history` for the captain bonus. Idempotent
   and atomic (transaction). Per-visit cost: ~30 row writes, dominated
   by the upstream FPL HTTP latency.

3. **Bulk backfill** (one-off bootstrap): see
   `src/database/backfillManagerCumulative.ts`. Single
   `INSERT … SELECT … window function` batched by `entry_id` in chunks
   of 10k, populating the whole table from existing `manager_history`
   (plus joins for chips and captain bonus). `ON CONFLICT (entry_id, gw)
   DO UPDATE` makes it safe to interrupt and rerun.

4. **Read paths**: `stratumCounts` and `computeRankPerPoint` (rank math),
   plus `sampleStratumAggregates` (comparison endpoint) all use
   `DISTINCT ON (entry_id) … ORDER BY gw DESC` to pull each entry's
   running total at the latest in-range GW, then subtract the latest
   pre-range row. `COALESCE` to 0 handles late-joiners. Entries with no
   in-range row drop, matching the "probes with history in range"
   semantic.

## Semantic invariant

One cumulative row per GW the entry has a history row for. No synthetic
anchor rows. No rows for GWs the entry didn't participate in. The
`DISTINCT ON` + `LEFT JOIN` pattern handles late-joiners, gap GWs, and
ranges that cross the join GW correctly via
`COALESCE(c_start.cumulative_points, 0)`.

If you ever loosen this (e.g. emit a `gw=0` anchor for everyone) the
query semantics will subtly drift — late-joiners will be counted as
0-point probes for ranges entirely before they joined, which deflates
rank estimates ~15–25% on early-season ranges.

## Chip half flags

`chip_wildcard_h1/h2`, `chip_freehit_h1/h2`, `chip_bboost_h1/h2` are
monotonically-true booleans, set the first time the entry plays that
chip in the corresponding half (`gw <= 19` for h1, `gw > 19` for h2).
Each FPL chip can be played at most once per half, so two flags suffice.

The comparison endpoint detects "chip played in [start, end]" via XOR of
end and start flags:

```
played = (end.h1 AND NOT start.h1) OR (end.h2 AND NOT start.h2)
```

This is correct for any (start, end) pair, including ranges that
straddle the half boundary. A single boolean would mis-detect ranges
that contain the second play but not the first.

The boundary is `CHIP_HALVES_BOUNDARY = 19` in
`src/database/populateManagers.ts` (mirrored as a literal in
`backfillManagerCumulative.ts`). If a future season changes the
boundary, update both and rerun `backfill-cumulative`.

## When to run the backfill

- **Once after a schema migration that adds cumulative columns**.
  Required — the migration's `NOT NULL DEFAULT` populates new columns
  with sentinel values; the backfill replaces them with real ones.
- **Optionally if the drift check below shows corruption**. Pure SQL,
  no FPL load.
- **Not after `reset-season`** — `wipeAllSeasonData()` truncates
  `manager_cumulative` along with `manager_history` and `manager_summary`.
  Per-entry rebuilds repopulate it inline as the cron crawls the new
  season. Optionally run the backfill after a few hours to accelerate
  S3 coverage.

## Inspecting state

```sql
-- Per-stratum coverage
SELECT stratum,
       COUNT(DISTINCT entry_id) AS entries,
       COUNT(*) AS rows,
       MIN(gw) AS min_gw,
       MAX(gw) AS max_gw
FROM manager_cumulative
GROUP BY stratum ORDER BY stratum;

-- Spot-check one entry: cumulative should monotonically increase
SELECT gw, cumulative_points, cumulative_transfers, cumulative_captain_bonus
FROM manager_cumulative WHERE entry_id = <some_id> ORDER BY gw;

-- Drift check: any entry whose cumulative max disagrees with summed history?
SELECT mc.entry_id,
       MAX(mc.cumulative_transfers) AS cum_max,
       SUM(COALESCE(mh.event_transfers, 0)) AS hist_sum
FROM manager_cumulative mc
JOIN manager_history mh USING (entry_id)
GROUP BY mc.entry_id
HAVING MAX(mc.cumulative_transfers) <> SUM(COALESCE(mh.event_transfers, 0))
LIMIT 20;
-- Same shape for cumulative_bench, cumulative_hits_cost,
-- cumulative_captain_bonus. Empty result == healthy.
```

If drift returns rows, re-run `npm run backfill-cumulative` (idempotent
`ON CONFLICT DO UPDATE` rewrites all rows from canonical history).

## Verification (precision win, not just perf)

`startGw=1` queries can compare estimated vs. official rank inline —
FPL stores cumulative rank at `endGw` in the entry's history payload,
which the response surfaces as `range_rank_official`:

```bash
for ID in <id1> <id2> <id3>; do
  curl -sS "http://localhost:3000/api/manager/$ID/range-rank?start=1&end=34" \
    | jq '{id: .entry_id, rank: .range_rank, official: .range_rank_official}'
done
```

`|rank − official|` median should land within ±10–15k of official for
typical S3 entries.

## Related files

- [`src/database/backfillManagerCumulative.ts`](../src/database/backfillManagerCumulative.ts) — one-off backfill script
- [`src/database/populateManagers.ts`](../src/database/populateManagers.ts) — `rebuildCumulativeForEntry` (steady-state maintenance)
- [`src/database/seasonManager.ts`](../src/database/seasonManager.ts) — `wipeAllSeasonData` includes `manager_cumulative`
- [`src/managers/getRangeRank.ts`](../src/managers/getRangeRank.ts) — `stratumCounts`
- [`src/managers/getTeamImpact.ts`](../src/managers/getTeamImpact.ts) — `computeRankPerPoint`
- [`src/managers/getManagerComparison.ts`](../src/managers/getManagerComparison.ts) — `sampleStratumAggregates`
- [`prisma/migrations/20260430120000_add_manager_cumulative`](../prisma/migrations/20260430120000_add_manager_cumulative/migration.sql) — initial table DDL
- [`prisma/migrations/20260430130000_manager_cumulative_distinct_on_index`](../prisma/migrations/20260430130000_manager_cumulative_distinct_on_index/migration.sql) — `(stratum, entry_id, gw DESC)` composite index
- [`prisma/migrations/20260502120000_extend_cumulative_and_stratum_captain_picks`](../prisma/migrations/20260502120000_extend_cumulative_and_stratum_captain_picks/migration.sql) — extended cumulative columns + `stratum_captain_picks_gw`
