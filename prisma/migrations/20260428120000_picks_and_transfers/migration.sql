-- Comparison-table extension: per-GW transfer count and per-GW captain/chip
-- picks for sampled managers.
-- manager_history.event_transfers: count of transfers made in the GW (not
--   just the cost). Nullable for rows ingested before this migration.
-- manager_picks: one row per (entry_id, gw) capturing captain element,
--   captain multiplier (2/3/0), vice captain, and active chip. Populated by
--   /entry/{id}/event/{gw}/picks/ during ingestion. Indexed by gw and
--   captain_element for fast "most captained" / "captain bonus" queries.

ALTER TABLE "manager_history" ADD COLUMN "event_transfers" INTEGER;

CREATE TABLE "manager_picks" (
    "entry_id" INTEGER NOT NULL,
    "gw" INTEGER NOT NULL,
    "captain_element" INTEGER,
    "vice_captain_element" INTEGER,
    "captain_multiplier" INTEGER,
    "active_chip" VARCHAR(20),

    CONSTRAINT "manager_picks_pkey" PRIMARY KEY ("entry_id","gw")
);

CREATE INDEX "manager_picks_gw_idx" ON "manager_picks"("gw");
CREATE INDEX "manager_picks_captain_element_idx" ON "manager_picks"("captain_element");

ALTER TABLE "manager_picks" ADD CONSTRAINT "manager_picks_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "manager_summary"("entry_id") ON DELETE CASCADE ON UPDATE CASCADE;
