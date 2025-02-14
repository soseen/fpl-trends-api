/*
  Warnings:

  - Made the column `footballer_id` on table `footballer_fixtures` required. This step will fail if there are existing NULL values in that column.
  - Made the column `fixture_id` on table `footballer_fixtures` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "footballer_fixtures" ALTER COLUMN "footballer_id" SET NOT NULL,
ALTER COLUMN "fixture_id" SET NOT NULL;
