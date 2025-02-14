-- CreateTable
CREATE TABLE "events" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "average_entry_score" INTEGER NOT NULL,
    "finished" BOOLEAN NOT NULL,
    "data_checked" BOOLEAN NOT NULL,
    "highest_scoring_entry" INTEGER,
    "deadline_time_epoch" INTEGER NOT NULL,
    "deadline_time_game_offset" INTEGER NOT NULL,
    "highest_score" INTEGER NOT NULL,
    "is_previous" BOOLEAN NOT NULL,
    "is_current" BOOLEAN NOT NULL,
    "is_next" BOOLEAN NOT NULL,
    "cup_leagues_created" BOOLEAN NOT NULL,
    "h2h_ko_matches_created" BOOLEAN NOT NULL,
    "can_enter" BOOLEAN NOT NULL,
    "can_manage" BOOLEAN NOT NULL,
    "released" BOOLEAN NOT NULL,
    "ranked_count" INTEGER NOT NULL,
    "most_selected" INTEGER NOT NULL,
    "most_transferred_in" INTEGER NOT NULL,
    "top_element" INTEGER NOT NULL,
    "transfers_made" INTEGER NOT NULL,
    "most_captained" INTEGER NOT NULL,
    "most_vice_captained" INTEGER NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);
