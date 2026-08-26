ALTER TABLE "manager_history"
ADD COLUMN "overall_rank" INTEGER;

CREATE INDEX "manager_history_gw_overall_rank_idx"
ON "manager_history"("gw", "overall_rank");

-- Existing rows were grouped by rank after the selected range. They must not
-- be served while the first post-deploy sample refresh rebuilds causal cohorts.
TRUNCATE TABLE "rank_band_player_exposure_gw";
