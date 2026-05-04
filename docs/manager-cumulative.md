# `manager-cumulative` — pre-aggregated range totals for high-precision rank

A **table + maintenance hook + one-off backfill** that lets the rank estimator query the full sample instead of a 1-in-30 sub-sample. Driven by [`src/database/populateManagers.ts`](../src/database/populateManagers.ts) (steady-state) and [`src/database/backfillManagerCumulative.ts`](../src/database/backfillManagerCumulative.ts) (one-off bootstrap).

> Not a cron, not a long-running script — it's a derived table. Backfill once after the schema migration, then it self-maintains forever.

## Why this exists

`getRangeRank.ts` and `computeRankPerPoint` (in [`getTeamImpact.ts`](../src/managers/getTeamImpact.ts)) want to know "across the stratum, what's each sampled manager's points total over GWs X–Y?" Done naively that's a `GROUP BY entry_id` over `manager_history` — for stratum 3 across a full season, ~21M rows scanned per query, 8–10 s on the prod box.

The pre-fix workaround was a deterministic sub-sample: `WHERE mh.entry_id % 30 = 0`. That cut the scan to ~700k rows but capped the effective S3 sample at ~21k probes out of the ~625k we've actually crawled. Variance scales as 1/√n, so the sub-sample multiplied range-rank std-dev by **√30 ≈ 5.5×** — a precision floor that running the populate cron longer cannot break.

`manager_cumulative` removes the trade-off. Each row is a manager's running points total at a given GW. Range total becomes a subtraction:

```
range_total[entry] = cumulative[entry, end_gw] − cumulative[entry, start_gw − 1]
```

Two indexed lookups per entry, no GROUP BY. The full 625k S3 sample fits in the query budget, dropping range-rank std-dev to ~±8k (from ~±43k) for typical S3 users.

## What it does, in plain terms

1. **Schema**: `manager_cumulative (entry_id, gw, cumulative_points, stratum, rejected_reason)`. Composite PK on `(entry_id, gw)`. `stratum` and `rejected_reason` are denormalised from `manager_summary` so the read path needs no join. Three indexes:
   - `(stratum, gw)` — for c_start (`WHERE stratum = X AND gw < Y` as a contiguous range).
   - `(stratum, rejected_reason, gw)` — same for the active-only c_start in `computeRankPerPoint`.
   - `(stratum, entry_id, gw DESC)` — for c_end (`DISTINCT ON (entry_id) ORDER BY entry_id, gw DESC` over a stratum partition). Without this index PG picks the primary key `(entry_id, gw)` and post-filters `stratum`, scanning the full table and Incremental-Sorting 12M+ rows.

2. **Maintenance** (steady state): every time `populateManagers.processEntry` upserts an entry's history rows, it then calls `rebuildCumulativeForEntry`. That function `DELETE`s all this entry's cumulative rows and re-inserts a fresh set — one row per (entry_id, gw) where `manager_history` has a row, with running totals in order. Idempotent and atomic (wrapped in a transaction). Per-visit cost: ~20–35 row writes, dominated by the upstream FPL HTTP latency.

3. **Backfill** (one-off): the first time you deploy this, the table is empty and the cron's per-entry maintenance only fills it for entries it visits. The bootstrap script runs a single `INSERT … SELECT … SUM() OVER (PARTITION BY entry_id ORDER BY gw)` window function, batched by `entry_id` in chunks of 10k, populating the whole table from existing `manager_history`.

4. **Read path**: gated behind the `USE_CUMULATIVE_TABLE` env var. When true, both `stratumCounts` and `computeRankPerPoint` use a **recursive CTE / loose index scan** to pull each entry's running total at the latest in-range GW, then subtract the latest pre-range row (`COALESCE` to 0 if entry joined inside the range). Entries with no in-range row drop, exactly matching the legacy "probes with history in range" semantic.

   The recursive form (`WITH RECURSIVE … UNION ALL … CROSS JOIN LATERAL … LIMIT 1`) is load-bearing: a naive `DISTINCT ON (entry_id) ORDER BY gw DESC` over the (stratum=N, gw IN range) partition reads ALL ~13M rows in stratum 3 and lets `Unique` pick one per group — that's ~4 s on prod even with the data fully cached and the `(stratum, entry_id, gw DESC)` index in place, because the bottleneck is the row stream itself. Recursive CTE walks ~400k distinct entry_ids one at a time, each iteration a single B-tree seek for `entry_id > previous AND gw IN range LIMIT 1`. PostgreSQL has no native skip-scan; this is the standard idiom for it.

## Semantic invariant

We emit one cumulative row **per GW the entry has a history row for**. No synthetic anchor rows. No rows for GWs the entry didn't participate in. The `DISTINCT ON` + `LEFT JOIN` query pattern handles late-joiners, gap GWs, and ranges that cross the join GW correctly via `COALESCE(c_start.cumulative_points, 0)`.

If you ever loosen this (e.g. emit a `gw=0` anchor for everyone) the query semantics will subtly drift — late-joiners will be counted as 0-point probes for ranges entirely before they joined, which deflates rank estimates ~15–25% on early-season ranges.

## Rollout sequence

The first deploy that includes the schema migration leaves the table empty and the read path on the legacy SQL. Steps to flip over to the new path:

### 1. Verify the migration landed

```bash
ssh deploy@91.98.145.120
sudo -u postgres psql -d fpl-trends-db -c "SELECT COUNT(*) FROM manager_cumulative;"
```

> **Note on `psql` auth.** The `fpl` DB user is configured for peer auth on the local socket, which means `psql -U fpl` only works when the OS user is also `fpl` — not `deploy`. For interactive ops, use `sudo -u postgres psql -d fpl-trends-db`: the `postgres` Linux user maps to the `postgres` DB superuser via peer auth and can read everything. The Node app uses TCP+password via `DATABASE_URL`, which is why it works regardless.

Should return `0` after first deploy. If the table doesn't exist yet, the migration didn't run — `cd ~/fpl-trends-api && npm run migrate`.

### 2. Run the one-off backfill

```bash
cd ~/fpl-trends-api && npm run backfill-cumulative
```

Single-digit minutes for ~24M `manager_history` rows on the CX23. Idempotent — safe to interrupt and rerun. No lockfile, no FPL API calls (it's pure SQL within Postgres).

Verify after:

```sql
-- Row counts per stratum:
SELECT stratum, COUNT(*) AS cum_rows, COUNT(DISTINCT entry_id) AS entries
FROM manager_cumulative
GROUP BY stratum ORDER BY stratum;

-- Sanity: cumulative row count ≈ manager_history row count.
SELECT
  (SELECT COUNT(*) FROM manager_history)  AS history_rows,
  (SELECT COUNT(*) FROM manager_cumulative) AS cumulative_rows;
```

The two counts should match within a few hundred — any drift comes from the cron's per-entry maintenance touching entries while the backfill ran, which is fine.

### 3. EXPLAIN ANALYZE the new query (read-only, flag still off)

```sql
EXPLAIN (ANALYZE, BUFFERS)
WITH c_end AS (
  SELECT DISTINCT ON (entry_id) entry_id, cumulative_points
  FROM manager_cumulative
  WHERE stratum = 3 AND gw BETWEEN 1 AND 34
  ORDER BY entry_id, gw DESC
),
c_start AS (
  SELECT DISTINCT ON (entry_id) entry_id, cumulative_points
  FROM manager_cumulative
  WHERE stratum = 3 AND gw < 1
  ORDER BY entry_id, gw DESC
)
SELECT
  COUNT(*) FILTER (WHERE s >= 1900)::int AS higher,
  COUNT(*)::int                          AS probes_with_history
FROM (
  SELECT c_end.cumulative_points - COALESCE(c_start.cumulative_points, 0) AS s
  FROM c_end
  LEFT JOIN c_start USING (entry_id)
) t;
```

Expectations:
- `Index Scan using manager_cumulative_stratum_entry_id_gw_idx` for c_end (NOT the pkey — see "Index gotcha" below).
- `Index Scan using manager_cumulative_stratum_gw_idx` for c_start.
- **No** `Incremental Sort` node anywhere.
- `Buffers: shared hit` dominates `read` after warm-up.
- Total runtime under ~500 ms warm. Run twice — second is the warm number.

#### Index gotcha

If you see `Index Scan using manager_cumulative_pkey` for c_end with a `Filter: (stratum = ...)` line and an `Incremental Sort` node above it (8+ s of the runtime), the planner is using the primary key `(entry_id, gw)` instead of the composite. That happens when `manager_cumulative_stratum_entry_id_gw_idx` is missing (e.g. you're on an older deploy that predates the index migration) — re-run `npm run migrate` to apply it. The primary key gives the right ordering but post-filters stratum, scanning the full table.

### 4. Flip the flag

```bash
echo "USE_CUMULATIVE_TABLE=true" >> ~/fpl-trends-api/.env
pm2 restart fpl-trends-api

# Confirm pm2 picked up the env var:
pm2 env 0 | grep USE_CUMULATIVE_TABLE
```

`server.ts` loads `dotenv/config` at the top, so the restart re-reads `.env`.

### 5. Smoke test

```bash
# Pick a real S3 entry from the sample.
sudo -u postgres psql -d fpl-trends-db -c \
  "SELECT entry_id, overall_rank FROM manager_summary WHERE stratum = 3 AND rejected_reason IS NULL ORDER BY entry_id LIMIT 1;"

# Replace ENTRY_ID with the result above.
curl -sS "http://localhost:3000/api/manager/ENTRY_ID/range-rank?start=1&end=34" | jq

# Tail logs for any errors over the next minute or two.
pm2 logs fpl-trends-api --lines 100
```

The response's `range_rank` should be much closer to `range_rank_official` than the pre-flag estimate.

## Rollback

If the new path misbehaves under prod load, revert the read path instantly without touching code:

```bash
sed -i '/^USE_CUMULATIVE_TABLE=/d' ~/fpl-trends-api/.env
pm2 restart fpl-trends-api
```

The cumulative table keeps being maintained either way — flipping back doesn't lose state, and re-flipping forward is just another env edit + restart.

## Inspecting state

```sql
-- Cumulative coverage per stratum
SELECT stratum,
       COUNT(DISTINCT entry_id) AS entries,
       COUNT(*) AS rows,
       MIN(gw) AS min_gw,
       MAX(gw) AS max_gw
FROM manager_cumulative
GROUP BY stratum ORDER BY stratum;

-- Spot-check one entry: cumulative should monotonically increase across GWs
SELECT gw, cumulative_points
FROM manager_cumulative
WHERE entry_id = <some_id>
ORDER BY gw;

-- Drift check: any entry whose cumulative max disagrees with their summed
-- history? Should be empty if maintenance is healthy.
SELECT mc.entry_id,
       MAX(mc.cumulative_points) AS cum_max,
       SUM(mh.points)            AS hist_sum
FROM manager_cumulative mc
JOIN manager_history mh ON mh.entry_id = mc.entry_id
GROUP BY mc.entry_id
HAVING MAX(mc.cumulative_points) <> SUM(mh.points)
LIMIT 20;
```

If the drift query returns rows, something has corrupted the cumulative state — probably worth re-running `npm run backfill-cumulative` (idempotent `ON CONFLICT DO UPDATE` rewrites all rows from the canonical history).

## Who this helps

- **Stratum 3 users** (overall rank > 100k — the vast majority of FPL): ~5× tighter range-rank estimate, plus more stable rank-killer attribution.
- **Stratum 1 / 2 users** (top 100k): no change. Those strata were already censused, no sub-sample applied — the legacy and new paths give identical numbers.

What this **does not** fix: captain/EO rate noise. That's bottlenecked by `manager_picks` density (only `currentGw` ingested per visit), not query shape. See [`backfill-picks.md`](./backfill-picks.md) for the orthogonal flow that addresses captain coverage.

## When to re-run the backfill

- **Once after the schema migration that added `manager_cumulative`** (commit `<this PR>`). Required.
- **Once after `npm run reset-season`** — `wipeAllSeasonData()` truncates `manager_cumulative` along with `manager_history` and `manager_summary`. After the new season's populate has been running for a few hours and `manager_history` has rebuilt, run the backfill once more to repopulate cumulative for everyone the cron has already visited. (The cron's per-entry maintenance will fill it inline going forward — you don't *strictly* need the backfill, but running it accelerates coverage.)
- **Optionally if the drift check above shows corruption** — pure SQL, no FPL load, ~5 minutes.

## When NOT to run the backfill

- Fresh server bootstrap with no manager data — pointless, source data is empty. First populate-managers cron tick will create cumulative rows inline.
- While `populate-managers` is mid-tick — fine, actually. Both write to `manager_cumulative` via primary-key upsert, so they can't conflict; they'll just be doing the same work twice for any entries the cron touches during the backfill window.

## Safety rails

- **Atomic per-entry rebuild** — `rebuildCumulativeForEntry` wraps `DELETE … WHERE entry_id = X` and the multi-row `INSERT` in a single `prisma.$transaction`. A crash mid-rebuild leaves either the old set or the new set, never a half-state.
- **Idempotent backfill** — `INSERT … ON CONFLICT (entry_id, gw) DO UPDATE` from the window-function source. Restart-safe.
- **Cascade FK to `manager_summary`** — entry deletes propagate. `wipeAllSeasonData()` also truncates `manager_cumulative` explicitly (FK cascade would handle it, but the explicit `deleteMany` keeps the wipe log auditable).
- **Feature flag for the read path** — `USE_CUMULATIVE_TABLE=true|false` switches `stratumCounts` and `computeRankPerPoint` between the new and legacy SQL with no redeploy. Plan to remove the flag (and the legacy code paths) after a clean day.

## Verification (precision win, not just perf)

Spot-check on a handful of S3 entries with `range_rank_official` populated (any `startGw=1` query — FPL stores cumulative rank at `endGw` in the entry's history payload, which the response surfaces as `range_rank_official`):

```bash
for ID in <id1> <id2> <id3>; do
  curl -sS "http://localhost:3000/api/manager/$ID/range-rank?start=1&end=34" \
    | jq '{id: .entry_id, rank: .range_rank, official: .range_rank_official}'
done
```

The `|rank − official|` median should drop ~5× from the pre-flag baseline. Pre-flag a typical S3 entry might show `rank: 928000, official: 800000`; post-flag the same entry should land within ±10–15k of official.

## Related files

- [`src/database/backfillManagerCumulative.ts`](../src/database/backfillManagerCumulative.ts) — one-off backfill script
- [`src/database/populateManagers.ts`](../src/database/populateManagers.ts) — `rebuildCumulativeForEntry` (steady-state maintenance)
- [`src/database/seasonManager.ts`](../src/database/seasonManager.ts) — `wipeAllSeasonData` includes `manager_cumulative`
- [`src/managers/getRangeRank.ts`](../src/managers/getRangeRank.ts) — `stratumCounts`, gated by `USE_CUMULATIVE_TABLE`
- [`src/managers/getTeamImpact.ts`](../src/managers/getTeamImpact.ts) — `computeRankPerPoint`, same flag
- [`prisma/migrations/20260430120000_add_manager_cumulative/migration.sql`](../prisma/migrations/20260430120000_add_manager_cumulative/migration.sql) — table DDL
- [`prisma/migrations/20260430130000_manager_cumulative_distinct_on_index/migration.sql`](../prisma/migrations/20260430130000_manager_cumulative_distinct_on_index/migration.sql) — `(stratum, entry_id, gw DESC)` composite index for the `DISTINCT ON` path
