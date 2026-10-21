-- Move causal manager-comparison aggregation off the HTTP request path.
-- Existing cumulative rows must be refreshed once with
-- `npm run backfill-cumulative` before rebuilding this read model.
ALTER TABLE "manager_cumulative"
    ADD COLUMN "transfer_gws_cum"      INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "hits_gws_cum"          INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "bench_gws_cum"         INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "chip_triplecaptain_h1" BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN "chip_triplecaptain_h2" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE "comparison_range_stats" (
    "stratum"                    INTEGER NOT NULL,
    "start_gw"                   INTEGER NOT NULL,
    "end_gw"                     INTEGER NOT NULL,
    "sample_size"                INTEGER NOT NULL,
    "sum_points"                 BIGINT NOT NULL,
    "sum_gws"                    BIGINT NOT NULL,
    "complete_transfers"         INTEGER NOT NULL,
    "sum_transfers_complete"     BIGINT NOT NULL,
    "complete_hits"              INTEGER NOT NULL,
    "sum_hits_cost_complete"     BIGINT NOT NULL,
    "complete_bench"             INTEGER NOT NULL,
    "sum_bench_complete"         BIGINT NOT NULL,
    "complete_captain"           INTEGER NOT NULL,
    "sum_captain_complete"       BIGINT NOT NULL,
    "complete_chips"             INTEGER NOT NULL,
    "wildcards_h1"               BIGINT NOT NULL,
    "wildcards_h2"               BIGINT NOT NULL,
    "freehits_h1"                BIGINT NOT NULL,
    "freehits_h2"                BIGINT NOT NULL,
    "bboosts_h1"                 BIGINT NOT NULL,
    "bboosts_h2"                 BIGINT NOT NULL,
    "triplecaptains_h1"          BIGINT NOT NULL,
    "triplecaptains_h2"          BIGINT NOT NULL,
    "last_rebuilt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comparison_range_stats_pkey"
        PRIMARY KEY ("stratum", "start_gw", "end_gw")
);

CREATE INDEX "comparison_range_stats_lookup_idx"
    ON "comparison_range_stats" ("start_gw", "end_gw", "stratum");
