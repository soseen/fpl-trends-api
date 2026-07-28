ALTER TABLE "footballers"
ADD COLUMN "history_past" JSONB;

CREATE TABLE "season_archives" (
    "season" VARCHAR(10) NOT NULL,
    "footballers_data" JSONB NOT NULL,
    "teams_data" JSONB NOT NULL,
    "events_data" JSONB NOT NULL,
    "total_players" INTEGER NOT NULL,
    "archived_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "season_archives_pkey" PRIMARY KEY ("season")
);
