-- Small materialized copy for current-GW rebuilds; the complete, immutable
-- replay input remains in source_payload.
ALTER TABLE analytics_benchmarks ADD COLUMN followup_payload JSONB;
