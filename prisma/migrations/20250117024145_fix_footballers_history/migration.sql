/*
  Warnings:

  - The primary key for the `history` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `fixture` on the `history` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "history" DROP CONSTRAINT "history_pkey",
DROP COLUMN "fixture",
ADD CONSTRAINT "history_pkey" PRIMARY KEY ("footballer_id", "fixture_id");
