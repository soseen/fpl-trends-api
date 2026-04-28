-- AlterTable
-- FPL's bootstrap-static can return null for these on some events
-- (observed on older finished GWs); they were previously NOT NULL,
-- which made every populate run crash on the events upsert.
ALTER TABLE "events" ALTER COLUMN "most_captained" DROP NOT NULL;
ALTER TABLE "events" ALTER COLUMN "most_vice_captained" DROP NOT NULL;
