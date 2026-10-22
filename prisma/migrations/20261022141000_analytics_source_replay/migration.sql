-- Gzipped normalized source input, not a second indexed copy of the working
-- facts. This retains reproducibility without multiplying JSON history size.
ALTER TABLE analytics_benchmarks ADD COLUMN source_payload BYTEA;
ALTER TABLE manager_picks ADD COLUMN sample_page INTEGER;
ALTER TABLE manager_picks ADD CONSTRAINT manager_picks_sample_page_positive CHECK (sample_page > 0) NOT VALID;
