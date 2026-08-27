-- Existing rows were grouped by each manager's post-range/current rank.
-- Empty the derived table so no outcome-selected comparator is served before
-- the next read-model rebuild repopulates it with pre-range cohort semantics.
TRUNCATE TABLE "stratum_range_xfer_avg";
