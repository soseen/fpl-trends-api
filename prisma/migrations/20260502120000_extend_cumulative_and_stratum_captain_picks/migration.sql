-- Extend manager_cumulative with running totals for the comparison endpoint
-- and add stratum_captain_picks_gw for fast captain-rate queries.
--
-- Both changes are read-path-additive: existing queries (getRangeRank,
-- getTeamImpact rank density) keep working unchanged off the existing
-- columns and indexes. Read paths in getManagerComparison and
-- getTeamImpact.fetchCaptainRatesInStratum will be flipped over once
-- backfills have run (see backfillManagerCumulative.ts and
-- backfillStratumCaptainPicks.ts).
--
-- All new manager_cumulative columns use NOT NULL DEFAULT so the migration
-- can be applied to a populated DB without rewriting every row up-front.
-- Backfill replaces the defaults with real values via ON CONFLICT … DO UPDATE.

-- ----------------------------------------------------------------------------
-- 1. Extend manager_cumulative
-- ----------------------------------------------------------------------------

ALTER TABLE "manager_cumulative"
    ADD COLUMN "cumulative_transfers"     INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "cumulative_hits_cost"     INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "cumulative_bench"         INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "cumulative_captain_bonus" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "gws_played"               INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "chip_wildcard_h1"         BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN "chip_wildcard_h2"         BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN "chip_freehit_h1"          BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN "chip_freehit_h2"          BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN "chip_bboost_h1"           BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN "chip_bboost_h2"           BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN "has_transfers"            BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN "has_hits"                 BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN "has_bench"                BOOLEAN NOT NULL DEFAULT FALSE;

-- ----------------------------------------------------------------------------
-- 2. New stratum_captain_picks_gw table
-- ----------------------------------------------------------------------------

-- Per-(stratum, gw, captain_element, captain_multiplier) pick counts,
-- rebuilt at the end of each populate run. ~17k rows total — replaces the
-- per-request GROUP BY over manager_picks ⨝ manager_summary in
-- getTeamImpact.fetchCaptainRatesInStratum and
-- getManagerComparison.sampleMostCaptained.
CREATE TABLE "stratum_captain_picks_gw" (
    "stratum"            INTEGER     NOT NULL,
    "gw"                 INTEGER     NOT NULL,
    "captain_element"    INTEGER     NOT NULL,
    "captain_multiplier" INTEGER     NOT NULL,
    "picks"              INTEGER     NOT NULL,
    "active_picks"       INTEGER     NOT NULL,
    "last_rebuilt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stratum_captain_picks_gw_pkey"
        PRIMARY KEY ("stratum", "gw", "captain_element", "captain_multiplier")
);

-- Hot path: SUM(active_picks) per (stratum, gw) for sample-size lookup,
-- and per-(stratum, gw) row scan for captain-rate computation.
CREATE INDEX "stratum_captain_picks_gw_stratum_gw_idx"
    ON "stratum_captain_picks_gw" ("stratum", "gw");
