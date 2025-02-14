/*
  Warnings:

  - The primary key for the `history` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - Added the required column `fixture` to the `history` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "history" DROP CONSTRAINT "history_fixture_id_fkey";

-- AlterTable
ALTER TABLE "history" DROP CONSTRAINT "history_pkey",
ADD COLUMN     "fixture" INTEGER NOT NULL,
ADD CONSTRAINT "history_pkey" PRIMARY KEY ("footballer_id", "fixture");
