/*
  Warnings:

  - You are about to drop the `fixtures` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[code]` on the table `footballer_fixtures` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "footballer_fixtures" DROP CONSTRAINT "footballer_fixtures_fixture_id_fkey";

-- AlterTable
ALTER TABLE "footballer_fixtures" ADD COLUMN     "code" INTEGER,
ADD COLUMN     "event" INTEGER,
ADD COLUMN     "event_name" VARCHAR(255),
ADD COLUMN     "finished" BOOLEAN,
ADD COLUMN     "kickoff_time" TIMESTAMP(6),
ADD COLUMN     "minutes" INTEGER,
ADD COLUMN     "provisional_start_time" BOOLEAN,
ADD COLUMN     "team_a" INTEGER,
ADD COLUMN     "team_a_score" INTEGER,
ADD COLUMN     "team_h" INTEGER,
ADD COLUMN     "team_h_score" INTEGER;

-- DropTable
DROP TABLE "fixtures";

-- CreateIndex
CREATE UNIQUE INDEX "footballer_fixtures_code_key" ON "footballer_fixtures"("code");
