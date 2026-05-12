-- Speeds rank-density reads used by team-impact, transfers, and
-- captain-impact. The read path counts only managers within a narrow
-- cumulative_points window for a fixed (gw, stratum), so keep those columns
-- adjacent in the index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "manager_cumulative_gw_stratum_points_idx"
    ON "manager_cumulative" ("gw", "stratum", "cumulative_points");
