-- Precomputed manager range-total histograms.
--
-- This replaces request-time DISTINCT ON scans over manager_cumulative for
-- range-rank and team-impact rank-density calculations. The table is rebuilt
-- after manager sampling runs and is tiny compared with manager_cumulative:
-- one row per (stratum, start_gw, end_gw, score bucket).

CREATE TABLE IF NOT EXISTS "manager_range_score_buckets" (
    "stratum"      INTEGER      NOT NULL,
    "start_gw"     INTEGER      NOT NULL,
    "end_gw"       INTEGER      NOT NULL,
    "range_total"  INTEGER      NOT NULL,
    "managers"     INTEGER      NOT NULL,
    "last_rebuilt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manager_range_score_buckets_pkey"
        PRIMARY KEY ("stratum", "start_gw", "end_gw", "range_total")
);

CREATE INDEX IF NOT EXISTS "manager_range_score_buckets_start_end_idx"
    ON "manager_range_score_buckets" ("start_gw", "end_gw", "stratum", "range_total");

-- Speeds the read-model rebuild: exact end-GW scan, grouped by stratum and
-- entry, with start anchors resolved by manager_cumulative_pkey.
CREATE INDEX IF NOT EXISTS "manager_cumulative_gw_stratum_entry_id_idx"
    ON "manager_cumulative" ("gw", "stratum", "entry_id");
