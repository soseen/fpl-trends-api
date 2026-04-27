-- Manager comparison feature additions.
-- events.chip_plays: stores the bootstrap-static chip_plays array
--   ([{chip_name, num_played}, ...]) verbatim, so we can compute "% of
--   managers who used chip X in this range" without re-fetching bootstrap.
-- manager_history.event_transfers_cost / points_on_bench: per-GW values
--   from entry/{id}/history needed for averaging hits and bench points
--   across sampled managers. Nullable because rows ingested before this
--   migration don't have these fields.

ALTER TABLE "events" ADD COLUMN "chip_plays" JSONB;

ALTER TABLE "manager_history" ADD COLUMN "event_transfers_cost" INTEGER;
ALTER TABLE "manager_history" ADD COLUMN "points_on_bench" INTEGER;
