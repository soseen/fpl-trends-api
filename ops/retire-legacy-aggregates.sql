-- Run after both applications switch to published analytics and a
-- predeployment export passes a restore drill. Facts and replay archives stay.
-- Rollback to legacy serving requires rebuilding its aggregates.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
DO $$
DECLARE
  current_season text;
  latest integer;
  publications integer;
BEGIN
  IF NOT COALESCE((SELECT value = 'published-v1' FROM app_metadata
    WHERE key = 'analytics_serving_architecture'), false) THEN
    RAISE EXCEPTION 'Switch production to published analytics before retiring legacy aggregates';
  END IF;
  IF NOT COALESCE((SELECT value::timestamptz > now() - interval '24 hours'
    FROM app_metadata WHERE key = 'analytics_last_verified_export'), false) THEN
    RAISE EXCEPTION 'A recent successfully restored export is required';
  END IF;
  SELECT value INTO current_season FROM app_metadata WHERE key = 'current_season';
  SELECT MAX(id) INTO latest FROM events;
  SELECT COUNT(*) INTO publications FROM analytics_publications p
    JOIN analytics_benchmarks b ON b.id = p.benchmark_id
    WHERE p.season = current_season AND b.source_payload IS NOT NULL;
  IF latest IS NULL OR publications <> latest THEN
    RAISE EXCEPTION 'Every played gameweek needs a published replay archive';
  END IF;
END $$;
TRUNCATE TABLE manager_cumulative, manager_range_score_buckets,
  stratum_captain_picks_gw, stratum_gw_running_stats,
  stratum_range_xfer_avg, rank_band_player_exposure_gw;
COMMIT;
