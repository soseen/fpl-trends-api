-- FPL may omit transfer totals even for historical events. Preserve unknown
-- values so ingestion succeeds without treating missing totals as zero.
ALTER TABLE "events" ALTER COLUMN "transfers_made" DROP NOT NULL;
