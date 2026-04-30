-- Per-(entry_id, gw) running total of manager_history.points up to and
-- including that GW. Maintained by populateManagers.processEntry on every
-- visit; backfilled once via `npm run backfill-cumulative`.
--
-- Lets stratumCounts (getRangeRank) and computeRankPerPoint (getTeamImpact)
-- compute a manager's range total as
--   cumulative[end_gw] − cumulative[start_gw − 1]
-- — two indexed lookups per entry instead of a GROUP BY over the full
-- manager_history scan. With this in place we can drop the SAMPLE_DIVISOR_S3
-- sub-sample and use the full ~625k S3 sample, lifting range-rank precision
-- by ~5×.
--
-- stratum and rejected_reason are denormalised so the hot query needs no
-- join with manager_summary; processEntry re-writes them on every rebuild
-- so they stay in sync (including stratum changes when a manager moves
-- between cohorts).

CREATE TABLE "manager_cumulative" (
    "entry_id"          INTEGER NOT NULL,
    "gw"                INTEGER NOT NULL,
    "cumulative_points" INTEGER NOT NULL,
    "stratum"           INTEGER NOT NULL,
    "rejected_reason"   VARCHAR(20),

    CONSTRAINT "manager_cumulative_pkey" PRIMARY KEY ("entry_id", "gw")
);

-- Hot path: stratumCounts (range-rank) filters by stratum and looks up
-- (gw <= endGw, gw < startGw) per entry via DISTINCT ON.
CREATE INDEX "manager_cumulative_stratum_gw_idx"
    ON "manager_cumulative" ("stratum", "gw");

-- Rank-killer (computeRankPerPoint) adds a `rejected_reason IS NULL` filter.
CREATE INDEX "manager_cumulative_stratum_rejected_gw_idx"
    ON "manager_cumulative" ("stratum", "rejected_reason", "gw");

-- Cascade with manager_summary so resetSeason / per-entry deletes propagate.
ALTER TABLE "manager_cumulative"
    ADD CONSTRAINT "manager_cumulative_entry_id_fkey"
    FOREIGN KEY ("entry_id") REFERENCES "manager_summary"("entry_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
