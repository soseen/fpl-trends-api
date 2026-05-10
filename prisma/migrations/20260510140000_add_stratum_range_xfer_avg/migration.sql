-- Per-(stratum, start_gw, end_gw) precomputed average net points per transfer.
--
-- Replaces the per-request sampleAvgPtsPerTransfer query that joins
-- manager_transfers ⨝ history with a generate_series CTE — three calls
-- in parallel (active / stratum12 / stratum1) was the dominant cost in
-- /api/manager/:id/comparison (~18s of the 23s total).
--
-- Storage shape: per stratum, per (start_gw, end_gw) range, store the SUM
-- of per-manager averages and the count of managers contributing. Combined
-- strata are derived at read time by SUMming across the relevant rows.
-- with_data and stratum_size are stored redundantly per row (they don't
-- depend on the range) but the table is tiny — at season end <= 38 × 38 / 2
-- ranges × 3 strata ≈ 2200 rows — so the redundancy is a non-issue.
--
-- Crucially, this rebuild uses the FULL stratum-3 ingested sample (no
-- per-request entry_id % 32 sub-sample). That's accuracy-preserving by
-- construction: more sampled managers contribute → tighter confidence
-- interval, same expected value. The previous request-time 1/32 sub-sample
-- was a budget compromise we no longer need.
--
-- Rebuild strategy:
--   - Cron (rebuildManagerReadModels): only refresh end_gw=currentGw column.
--     Older ranges drift slightly as new managers ingest, but the drift is
--     small and manual backfill resyncs.
--   - Backfill (npm run backfill-stratum-range-xfer-avg): full rebuild,
--     all (start_gw, end_gw) pairs. Run after deploy; periodically for
--     drift correction.

CREATE TABLE "stratum_range_xfer_avg" (
    "stratum"             INTEGER          NOT NULL,
    "start_gw"            INTEGER          NOT NULL,
    "end_gw"              INTEGER          NOT NULL,
    -- SUM of per-manager (net / xfers) for managers in this stratum with at
    -- least one transfer in [start_gw, end_gw]. Combined-stratum mean of
    -- means via SUM(sum_per_manager_avg) / SUM(managers_with_xfers).
    "sum_per_manager_avg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    -- Count of managers contributing to sum_per_manager_avg.
    "managers_with_xfers" INTEGER          NOT NULL DEFAULT 0,
    -- Coverage gate: count of stratum managers with has_transfer_history=true
    -- at last_rebuilt time. Stored per row for one-shot lookup; doesn't
    -- depend on (start_gw, end_gw).
    "with_data"           INTEGER          NOT NULL DEFAULT 0,
    -- Total stratum population at last_rebuilt time. Same independence note.
    "stratum_size"        INTEGER          NOT NULL DEFAULT 0,
    "last_rebuilt"        TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stratum_range_xfer_avg_pkey"
        PRIMARY KEY ("stratum", "start_gw", "end_gw")
);

-- Hot-path lookup pattern: WHERE start_gw = $1 AND end_gw = $2 AND stratum = ANY($3)
CREATE INDEX "stratum_range_xfer_avg_lookup_idx"
    ON "stratum_range_xfer_avg" ("start_gw", "end_gw", "stratum");
