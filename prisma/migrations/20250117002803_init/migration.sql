-- CreateTable
CREATE TABLE "fixtures" (
    "id" SERIAL NOT NULL,
    "code" INTEGER,
    "team_h" INTEGER,
    "team_h_score" INTEGER,
    "team_a" INTEGER,
    "team_a_score" INTEGER,
    "event" INTEGER,
    "finished" BOOLEAN,
    "minutes" INTEGER,
    "provisional_start_time" BOOLEAN,
    "kickoff_time" TIMESTAMP(6),
    "event_name" VARCHAR(255),
    "is_home" BOOLEAN,
    "difficulty" INTEGER,

    CONSTRAINT "fixtures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "footballer_fixtures" (
    "id" SERIAL NOT NULL,
    "footballer_id" INTEGER,
    "fixture_id" INTEGER,

    CONSTRAINT "footballer_fixtures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "footballers" (
    "id" SERIAL NOT NULL,
    "team_id" INTEGER,
    "web_name" VARCHAR(255),
    "code" INTEGER,
    "first_name" VARCHAR(255),
    "second_name" VARCHAR(255),
    "team_code" INTEGER,
    "now_cost" INTEGER,
    "selected_by_percent" VARCHAR(10),
    "goals_scored" INTEGER,
    "assists" INTEGER,
    "bonus" INTEGER,
    "bps" INTEGER,
    "total_points" INTEGER,
    "status" VARCHAR(10),
    "news" TEXT,
    "expected_goals" VARCHAR(10),
    "expected_assists" VARCHAR(10),
    "expected_goal_involvements" VARCHAR(10),
    "expected_goals_conceded" VARCHAR(10),
    "expected_goals_per_90" DOUBLE PRECISION,
    "expected_assists_per_90" DOUBLE PRECISION,
    "expected_goal_involvements_per_90" DOUBLE PRECISION,
    "expected_goals_conceded_per_90" DOUBLE PRECISION,
    "goals_conceded_per_90" DOUBLE PRECISION,
    "element_type" INTEGER,
    "can_transact" BOOLEAN,
    "can_select" BOOLEAN,
    "chance_of_playing_next_round" INTEGER,
    "chance_of_playing_this_round" INTEGER,
    "cost_change_event" INTEGER,
    "cost_change_event_fall" INTEGER,
    "cost_change_start" INTEGER,
    "cost_change_start_fall" INTEGER,
    "dreamteam_count" INTEGER,
    "ep_next" VARCHAR(10),
    "ep_this" VARCHAR(10),
    "event_points" INTEGER,
    "form" VARCHAR(10),
    "in_dreamteam" BOOLEAN,
    "news_added" TIMESTAMP(6),
    "photo" VARCHAR(255),
    "points_per_game" VARCHAR(10),
    "removed" BOOLEAN,
    "special" BOOLEAN,
    "squad_number" INTEGER,
    "team" INTEGER,
    "transfers_in" INTEGER,
    "transfers_in_event" INTEGER,
    "transfers_out" INTEGER,
    "transfers_out_event" INTEGER,
    "value_form" VARCHAR(10),
    "value_season" VARCHAR(10),
    "region" INTEGER,
    "team_join_date" DATE,
    "minutes" INTEGER,
    "clean_sheets" INTEGER,
    "goals_conceded" INTEGER,
    "own_goals" INTEGER,
    "penalties_saved" INTEGER,
    "penalties_missed" INTEGER,
    "yellow_cards" INTEGER,
    "red_cards" INTEGER,
    "saves" INTEGER,
    "influence" VARCHAR(10),
    "creativity" VARCHAR(10),
    "threat" VARCHAR(10),
    "ict_index" VARCHAR(10),
    "starts" INTEGER,
    "influence_rank" INTEGER,
    "influence_rank_type" INTEGER,
    "creativity_rank" INTEGER,
    "creativity_rank_type" INTEGER,
    "threat_rank" INTEGER,
    "threat_rank_type" INTEGER,
    "ict_index_rank" INTEGER,
    "ict_index_rank_type" INTEGER,
    "corners_and_indirect_freekicks_order" INTEGER,
    "corners_and_indirect_freekicks_text" TEXT,
    "direct_freekicks_order" INTEGER,
    "direct_freekicks_text" TEXT,
    "penalties_order" INTEGER,
    "penalties_text" TEXT,
    "saves_per_90" DOUBLE PRECISION,
    "now_cost_rank" INTEGER,
    "now_cost_rank_type" INTEGER,
    "form_rank" INTEGER,
    "form_rank_type" INTEGER,
    "points_per_game_rank" INTEGER,
    "points_per_game_rank_type" INTEGER,
    "selected_rank" INTEGER,
    "selected_rank_type" INTEGER,
    "starts_per_90" DOUBLE PRECISION,
    "clean_sheets_per_90" DOUBLE PRECISION,

    CONSTRAINT "footballers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "history" (
    "id" SERIAL NOT NULL,
    "footballer_id" INTEGER NOT NULL,
    "history_id" BIGINT NOT NULL,
    "fixture" BIGINT NOT NULL,
    "opponent_team" INTEGER NOT NULL,
    "total_points" INTEGER NOT NULL,
    "was_home" BOOLEAN NOT NULL,
    "kickoff_time" TIMESTAMP(6) NOT NULL,
    "team_h_score" INTEGER,
    "team_a_score" INTEGER,
    "round" INTEGER NOT NULL,
    "modified" BOOLEAN NOT NULL,
    "minutes" INTEGER NOT NULL,
    "goals_scored" INTEGER NOT NULL,
    "assists" INTEGER NOT NULL,
    "clean_sheets" INTEGER NOT NULL,
    "goals_conceded" INTEGER NOT NULL,
    "own_goals" INTEGER NOT NULL,
    "penalties_saved" INTEGER NOT NULL,
    "penalties_missed" INTEGER NOT NULL,
    "yellow_cards" INTEGER NOT NULL,
    "red_cards" INTEGER NOT NULL,
    "saves" INTEGER NOT NULL,
    "bonus" INTEGER NOT NULL,
    "bps" INTEGER NOT NULL,
    "influence" VARCHAR(10) NOT NULL,
    "creativity" VARCHAR(10) NOT NULL,
    "threat" VARCHAR(10) NOT NULL,
    "ict_index" VARCHAR(10) NOT NULL,
    "starts" INTEGER NOT NULL,
    "expected_goals" VARCHAR(10) NOT NULL,
    "expected_assists" VARCHAR(10) NOT NULL,
    "expected_goal_involvements" VARCHAR(10) NOT NULL,
    "expected_goals_conceded" VARCHAR(10) NOT NULL,
    "value" INTEGER NOT NULL,
    "transfers_balance" INTEGER NOT NULL,
    "selected" INTEGER NOT NULL,
    "transfers_in" INTEGER NOT NULL,
    "transfers_out" INTEGER NOT NULL,

    CONSTRAINT "history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" SERIAL NOT NULL,
    "code" INTEGER,
    "name" VARCHAR(255),
    "short_name" VARCHAR(10),
    "strength" INTEGER,
    "strength_overall_home" INTEGER,
    "strength_overall_away" INTEGER,
    "strength_attack_home" INTEGER,
    "strength_attack_away" INTEGER,
    "strength_defence_home" INTEGER,
    "strength_defence_away" INTEGER,
    "played" INTEGER,
    "points" INTEGER,
    "position" INTEGER,
    "win" INTEGER,
    "draw" INTEGER,
    "loss" INTEGER,
    "form" VARCHAR(10),
    "team_division" INTEGER,
    "unavailable" BOOLEAN,
    "pulse_id" INTEGER,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fixtures_code_key" ON "fixtures"("code");

-- CreateIndex
CREATE UNIQUE INDEX "footballer_fixtures_footballer_id_fixture_id_key" ON "footballer_fixtures"("footballer_id", "fixture_id");

-- CreateIndex
CREATE UNIQUE INDEX "footballers_code_key" ON "footballers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "teams_code_key" ON "teams"("code");

-- CreateIndex
CREATE UNIQUE INDEX "teams_pulse_id_key" ON "teams"("pulse_id");

-- AddForeignKey
ALTER TABLE "footballer_fixtures" ADD CONSTRAINT "footballer_fixtures_fixture_id_fkey" FOREIGN KEY ("fixture_id") REFERENCES "fixtures"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "footballer_fixtures" ADD CONSTRAINT "footballer_fixtures_footballer_id_fkey" FOREIGN KEY ("footballer_id") REFERENCES "footballers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "footballers" ADD CONSTRAINT "fk_team" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "history" ADD CONSTRAINT "fk_footballer" FOREIGN KEY ("footballer_id") REFERENCES "footballers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
