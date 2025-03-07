-- CreateTable
CREATE TABLE "team_history" (
    "id" SERIAL NOT NULL,
    "team_id" INTEGER NOT NULL,
    "round" INTEGER NOT NULL,
    "team_xGC" DOUBLE PRECISION NOT NULL,
    "team_xGS" DOUBLE PRECISION NOT NULL,
    "goals" INTEGER NOT NULL,
    "goals_conceded" INTEGER NOT NULL,

    CONSTRAINT "team_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "team_history_team_id_key" ON "team_history"("team_id");

-- AddForeignKey
ALTER TABLE "team_history" ADD CONSTRAINT "team_history_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
