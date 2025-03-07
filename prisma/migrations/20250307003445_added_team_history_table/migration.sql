/*
  Warnings:

  - You are about to drop the column `team_xGC` on the `team_history` table. All the data in the column will be lost.
  - You are about to drop the column `team_xGS` on the `team_history` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[team_id,round]` on the table `team_history` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `teamXGC` to the `team_history` table without a default value. This is not possible if the table is not empty.
  - Added the required column `teamXGS` to the `team_history` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "team_history_team_id_key";

-- AlterTable
ALTER TABLE "team_history" DROP COLUMN "team_xGC",
DROP COLUMN "team_xGS",
ADD COLUMN     "teamXGC" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "teamXGS" DOUBLE PRECISION NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "team_history_team_id_round_key" ON "team_history"("team_id", "round");
