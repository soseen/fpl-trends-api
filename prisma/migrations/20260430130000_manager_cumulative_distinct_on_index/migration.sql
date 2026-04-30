-- Composite (stratum, entry_id, gw DESC) index for the c_end CTE in
-- stratumCounts (getRangeRank.ts) and computeRankPerPoint (getTeamImpact.ts).
--
-- Without this, PG's planner picks manager_cumulative_pkey (entry_id, gw)
-- for the DISTINCT ON (entry_id) ORDER BY entry_id, gw DESC step — because
-- the PK gives the right ordering — and post-filters `stratum = 3`. That
-- scans the entire table (~12M rows) and Incremental-Sorts most of them,
-- pushing range-rank queries to ~9–10 s.
--
-- With the new index, the planner can range-scan the stratum partition
-- already in (entry_id, gw DESC) order. No sort, ~10× speedup expected.
--
-- The existing manager_cumulative_stratum_gw_idx stays — it's still the
-- best fit for c_start (`WHERE stratum = X AND gw < Y` as a contiguous
-- range scan, no entry_id grouping required since startGw=1 is by far the
-- most common case and returns 0 rows).
--
-- CREATE INDEX CONCURRENTLY would be friendlier under load but Prisma
-- migrate-deploy doesn't run it inside a transaction-friendly context;
-- the table is small enough on prod (~12M rows) that a normal CREATE
-- INDEX is acceptable. Run during a quiet window if possible.

CREATE INDEX "manager_cumulative_stratum_entry_id_gw_idx"
    ON "manager_cumulative" ("stratum", "entry_id", "gw" DESC);
