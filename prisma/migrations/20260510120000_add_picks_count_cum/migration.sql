-- Add picks_count_cum to manager_cumulative.
--
-- Running count of GWs in [1..gw] where the manager has picks ingested
-- (i.e. a row in manager_picks). Used by
-- getManagerComparison.sampleCaptainAggregate to filter the sample to
-- managers with full picks coverage in the requested range. The previous
-- slow path ran a per-request `COUNT(DISTINCT mp.gw) = expected_gws` over
-- manager_picks with a LATERAL join into history per row; the same
-- "complete-coverage only" accuracy gate is now a two-row subtraction
-- (cum[end] − cum[start−1]) against an indexed cumulative table, and the
-- cumulative_captain_bonus delta replaces the LATERAL captain points sum.
--
-- NOT NULL DEFAULT 0 so the migration is non-blocking on the populated
-- prod table; backfillManagerCumulative replaces the defaults with real
-- values via ON CONFLICT … DO UPDATE, and steady-state populateManagers
-- maintains it on every visit through rebuildCumulativeForEntry.

ALTER TABLE "manager_cumulative"
    ADD COLUMN "picks_count_cum" INTEGER NOT NULL DEFAULT 0;
