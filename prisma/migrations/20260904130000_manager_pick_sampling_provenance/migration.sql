ALTER TABLE "manager_picks"
ADD COLUMN "sample_stratum" INTEGER,
ADD COLUMN "sampled_at_gw" INTEGER;

-- Existing current-season rows were populated by that GW's standings walk.
-- Persist the walk stratum now so the exposure rebuild can undo the sampler's
-- intentionally unequal inclusion probabilities (top 100k census vs tail).
UPDATE "manager_picks" mp
SET "sample_stratum" = ms."stratum",
    "sampled_at_gw" = mp."gw"
FROM "manager_summary" ms
WHERE ms."entry_id" = mp."entry_id";

CREATE INDEX "manager_picks_gw_sampled_at_gw_sample_stratum_idx"
ON "manager_picks"("gw", "sampled_at_gw", "sample_stratum");

-- These aggregates were built from outcome-conditioned raw counts. Never
-- serve them after the weighting code is deployed; the post-deploy rebuild or
-- next manager-populate pass recreates both from the provenance above.
TRUNCATE TABLE "rank_band_player_exposure_gw";
TRUNCATE TABLE "stratum_captain_picks_gw";
