-- Manager rank-estimation tables.
-- manager_summary: one row per FPL entry we've evaluated. Active entries have
--   rejected_reason = NULL; inactive/trolling/fetch_failed entries are recorded
--   too, so cron runs don't re-evaluate them every tick.
-- manager_history: per-GW net points (event_total minus event_transfers_cost)
--   for active entries only.

CREATE TABLE "manager_summary" (
    "entry_id" INTEGER NOT NULL,
    "overall_rank" INTEGER,
    "total_points" INTEGER,
    "stratum" INTEGER NOT NULL,
    "rejected_reason" VARCHAR(20),
    "last_checked_gw" INTEGER,
    "last_updated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manager_summary_pkey" PRIMARY KEY ("entry_id")
);

CREATE INDEX "manager_summary_stratum_idx" ON "manager_summary"("stratum");
CREATE INDEX "manager_summary_rejected_reason_idx" ON "manager_summary"("rejected_reason");

CREATE TABLE "manager_history" (
    "entry_id" INTEGER NOT NULL,
    "gw" INTEGER NOT NULL,
    "points" INTEGER NOT NULL,

    CONSTRAINT "manager_history_pkey" PRIMARY KEY ("entry_id","gw")
);

CREATE INDEX "manager_history_gw_idx" ON "manager_history"("gw");

ALTER TABLE "manager_history"
  ADD CONSTRAINT "manager_history_entry_id_fkey"
  FOREIGN KEY ("entry_id") REFERENCES "manager_summary"("entry_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
