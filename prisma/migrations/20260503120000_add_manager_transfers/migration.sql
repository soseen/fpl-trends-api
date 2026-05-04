-- Add manager_transfers and has_transfer_history flag for the new
-- Transfer Impact feature.
--
-- manager_transfers: one row per FPL transfer the manager has ever made.
-- Sourced from entry/{id}/transfers/ — populated lazily for users who hit
-- the /transfers endpoint and systematically for sampled managers during
-- populateManagers (gated by manager_summary.has_transfer_history so we
-- don't refetch on every cron pass).
--
-- The composite PK (entry_id, gw, in_element, out_element) is unique by
-- construction — FPL doesn't permit the same in/out swap twice in one GW.
-- Indexed on (entry_id, gw) for the per-user endpoint and on gw alone for
-- the comparison endpoint's stratum-wide aggregation.

CREATE TABLE "manager_transfers" (
    "entry_id"    INTEGER      NOT NULL,
    "gw"          INTEGER      NOT NULL,
    "in_element"  INTEGER      NOT NULL,
    "out_element" INTEGER      NOT NULL,
    "in_cost"     INTEGER      NOT NULL,
    "out_cost"    INTEGER      NOT NULL,
    "fetched_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manager_transfers_pkey"
        PRIMARY KEY ("entry_id", "gw", "in_element", "out_element")
);

CREATE INDEX "manager_transfers_entry_id_gw_idx"
    ON "manager_transfers" ("entry_id", "gw");

CREATE INDEX "manager_transfers_gw_idx"
    ON "manager_transfers" ("gw");

-- Coverage flag on manager_summary: gates the populate-side fetch so we
-- don't re-call FPL for every visit, but still leaves room for retry on
-- failure (set to TRUE only on a successful upsert).
ALTER TABLE "manager_summary"
    ADD COLUMN "has_transfer_history" BOOLEAN NOT NULL DEFAULT FALSE;
