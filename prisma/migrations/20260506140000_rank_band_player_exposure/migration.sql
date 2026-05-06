-- Store LiveFPL-style player EO by rank band. This is rebuilt from
-- manager_pick_elements after sample pick ingestion/backfills.

CREATE TABLE "rank_band_player_exposure_gw" (
    "rank_band"                INTEGER      NOT NULL,
    "gw"                       INTEGER      NOT NULL,
    "element_id"               INTEGER      NOT NULL,
    "sample_size"              INTEGER      NOT NULL,
    "squad_picks"              INTEGER      NOT NULL,
    "active_picks"             INTEGER      NOT NULL,
    "effective_multiplier_sum" INTEGER      NOT NULL,
    "last_rebuilt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rank_band_player_exposure_gw_pkey"
        PRIMARY KEY ("rank_band", "gw", "element_id")
);

CREATE INDEX "rank_band_player_exposure_gw_rank_band_gw_idx"
    ON "rank_band_player_exposure_gw" ("rank_band", "gw");

CREATE INDEX "manager_pick_elements_gw_element_id_idx"
    ON "manager_pick_elements" ("gw", "element_id");

CREATE INDEX "manager_summary_overall_rank_idx"
    ON "manager_summary" ("overall_rank");
