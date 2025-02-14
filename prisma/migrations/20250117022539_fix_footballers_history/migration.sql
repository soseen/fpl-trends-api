/*
  Warnings:

  - The primary key for the `history` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `element` on the `history` table. All the data in the column will be lost.
  - You are about to drop the column `fixture` on the `history` table. All the data in the column will be lost.
  - You are about to drop the column `history_id` on the `history` table. All the data in the column will be lost.
  - You are about to drop the column `id` on the `history` table. All the data in the column will be lost.
  - Added the required column `fixture_id` to the `history` table without a default value. This is not possible if the table is not empty.
  - Added the required column `footballer_id` to the `history` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "history" DROP CONSTRAINT "history_element_fkey";

-- DropIndex
DROP INDEX "history_element_fixture_key";

-- AlterTable
ALTER TABLE "history" DROP CONSTRAINT "history_pkey",
DROP COLUMN "element",
DROP COLUMN "fixture",
DROP COLUMN "history_id",
DROP COLUMN "id",
ADD COLUMN     "fixture_id" INTEGER NOT NULL,
ADD COLUMN     "footballer_id" INTEGER NOT NULL,
ALTER COLUMN "kickoff_time" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "influence" SET DATA TYPE TEXT,
ALTER COLUMN "creativity" SET DATA TYPE TEXT,
ALTER COLUMN "threat" SET DATA TYPE TEXT,
ALTER COLUMN "ict_index" SET DATA TYPE TEXT,
ALTER COLUMN "expected_goals" SET DATA TYPE TEXT,
ALTER COLUMN "expected_assists" SET DATA TYPE TEXT,
ALTER COLUMN "expected_goal_involvements" SET DATA TYPE TEXT,
ALTER COLUMN "expected_goals_conceded" SET DATA TYPE TEXT,
ADD CONSTRAINT "history_pkey" PRIMARY KEY ("footballer_id", "fixture_id");

-- AddForeignKey
ALTER TABLE "history" ADD CONSTRAINT "history_footballer_id_fkey" FOREIGN KEY ("footballer_id") REFERENCES "footballers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "history" ADD CONSTRAINT "history_fixture_id_fkey" FOREIGN KEY ("fixture_id") REFERENCES "fixtures"("id") ON DELETE CASCADE ON UPDATE CASCADE;
