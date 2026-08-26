ALTER TABLE "history"
ADD COLUMN "penalties_scored" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "fixture_code" INTEGER;

ALTER TABLE "team_history"
ADD COLUMN "teamNPXG" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "teamNPXGA" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE TABLE "penalty_records" (
    "season" VARCHAR(10) NOT NULL,
    "fixture_code" INTEGER NOT NULL,
    "player_code" INTEGER NOT NULL,
    "gameweek" INTEGER,
    "team_pulse_id" INTEGER,
    "opponent_pulse_id" INTEGER,
    "was_home" BOOLEAN,
    "scored" INTEGER NOT NULL DEFAULT 0,
    "missed" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "penalty_records_pkey" PRIMARY KEY ("season", "fixture_code", "player_code")
);

CREATE TABLE "penalty_feed_sync" (
    "season" VARCHAR(10) NOT NULL,
    "competition_season_id" INTEGER NOT NULL,
    "completed_fixture_count" INTEGER NOT NULL,
    "mapped_fixture_count" INTEGER NOT NULL,
    "scored_penalties" INTEGER NOT NULL,
    "missed_penalties" INTEGER NOT NULL,
    "deep_event_coverage" BOOLEAN NOT NULL DEFAULT false,
    "final_season" BOOLEAN NOT NULL DEFAULT false,
    "last_successful_refresh" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "penalty_feed_sync_pkey" PRIMARY KEY ("season")
);

CREATE TABLE "penalty_fixtures" (
    "season" VARCHAR(10) NOT NULL,
    "fixture_code" INTEGER NOT NULL,
    "premier_league_id" INTEGER NOT NULL,
    "gameweek" INTEGER,
    "home_team_pulse_id" INTEGER NOT NULL,
    "away_team_pulse_id" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "penalty_fixtures_pkey" PRIMARY KEY ("season", "fixture_code")
);

CREATE TABLE "penalty_fixture_players" (
    "season" VARCHAR(10) NOT NULL,
    "fixture_code" INTEGER NOT NULL,
    "player_code" INTEGER NOT NULL,
    "team_pulse_id" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "penalty_fixture_players_pkey" PRIMARY KEY ("season", "fixture_code", "player_code")
);

CREATE INDEX "penalty_records_season_player_code_idx"
ON "penalty_records"("season", "player_code");

CREATE INDEX "penalty_records_season_fixture_code_idx"
ON "penalty_records"("season", "fixture_code");

CREATE UNIQUE INDEX "penalty_fixtures_season_premier_league_id_key"
ON "penalty_fixtures"("season", "premier_league_id");

CREATE INDEX "penalty_fixtures_season_gameweek_idx"
ON "penalty_fixtures"("season", "gameweek");

CREATE INDEX "penalty_fixture_players_season_player_code_idx"
ON "penalty_fixture_players"("season", "player_code");
