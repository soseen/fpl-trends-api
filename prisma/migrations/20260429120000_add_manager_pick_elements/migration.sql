-- Lazy-populated table holding the full XV (1..15 picks) for users who hit
-- /api/manager/:id/team-impact. Populated on first request per (entry_id,
-- gw); subsequent requests read from here and skip the FPL API call.
-- `multiplier` is FPL's post-finalised value: 0 = benched, 1 = starter,
-- 2 = captain, 3 = triple captain. It already accounts for autosubs and
-- bench boost so downstream code can treat it as ground truth.

CREATE TABLE "manager_pick_elements" (
    "entry_id" INTEGER NOT NULL,
    "gw" INTEGER NOT NULL,
    "element_id" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "multiplier" INTEGER NOT NULL,
    "is_captain" BOOLEAN NOT NULL,
    "is_vice" BOOLEAN NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manager_pick_elements_pkey" PRIMARY KEY ("entry_id","gw","element_id")
);

CREATE INDEX "manager_pick_elements_entry_id_gw_idx" ON "manager_pick_elements"("entry_id", "gw");
