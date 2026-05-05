-- Store chip plays from the entry history payload.
--
-- This lets Top 100k / Top 10k chip usage come from the full sampled
-- manager-history population without fetching per-GW picks for every manager.

ALTER TABLE "manager_summary"
ADD COLUMN IF NOT EXISTS "has_chip_history" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "manager_history"
ADD COLUMN IF NOT EXISTS "active_chip" VARCHAR(20);

ALTER TABLE "stratum_gw_running_stats"
ADD COLUMN IF NOT EXISTS "count_with_chips" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "history_footballer_id_round_idx"
ON "history"("footballer_id", "round");
