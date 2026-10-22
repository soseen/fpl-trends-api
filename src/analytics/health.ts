import type { Request, Response } from "express";
import { readDatabase } from "./readDatabase.js";
import { CALCULATION_VERSION } from "./model.js";

export const analyticsReadiness = (_req: Request, res: Response): void => {
  void (async () => {
    const result = await readDatabase().query<{
      season: string | null;
      latest_gw: number;
      published_gws: number;
      worker_age_seconds: number | null;
      failed_jobs: number;
      partial_results: number;
      oldest_queued_seconds: number | null;
      bulk_refreshing: boolean;
      collector_age_seconds: number | null;
      sample_finalized: boolean;
    }>(
      `
      WITH state AS (SELECT (SELECT value FROM app_metadata WHERE key='current_season') AS season,(SELECT MAX(id) FROM events) AS latest_gw)
      SELECT s.*,
       COALESCE((SELECT value='1' FROM app_metadata WHERE key='analytics_bulk_refresh_in_progress'),false) AS bulk_refreshing,
       (SELECT COUNT(*)::int FROM analytics_publications p JOIN analytics_benchmarks b ON b.id=p.benchmark_id WHERE p.season=s.season AND p.gw<=s.latest_gw AND b.calculation_version=$1) AS published_gws,
       (SELECT EXTRACT(epoch FROM now()-value::timestamptz)::int FROM app_metadata WHERE key='analytics_worker_heartbeat') AS worker_age_seconds,
       (SELECT EXTRACT(epoch FROM now()-value::timestamptz)::int FROM app_metadata WHERE key='analytics_last_collector_success') AS collector_age_seconds,
       COALESCE((SELECT (b.payload->>'finalized')::boolean FROM analytics_publications p JOIN analytics_benchmarks b ON b.id=p.benchmark_id WHERE p.season=s.season AND p.gw=s.latest_gw),false) AS sample_finalized,
       (SELECT COUNT(*)::int FROM analytics_jobs WHERE season=s.season AND status='failed' AND error_code IS DISTINCT FROM 'manager_not_found' AND updated_at>now()-interval '1 hour') AS failed_jobs,
       (SELECT COUNT(*)::int FROM analytics_manager_results WHERE season=s.season AND created_at>now()-interval '10 minutes' AND payload->'sectionErrors'<>'{}'::jsonb) AS partial_results,
       (SELECT EXTRACT(epoch FROM now()-MIN(updated_at))::int FROM analytics_jobs WHERE season=s.season AND status='queued') AS oldest_queued_seconds
      FROM state s`,
      [CALCULATION_VERSION],
    );
    const data = result.rows[0];
    const ready =
      !!data?.season &&
      data.published_gws === data.latest_gw &&
      data.worker_age_seconds !== null &&
      data.worker_age_seconds < 90 &&
      (data.oldest_queued_seconds ?? 0) < 180 &&
      data.failed_jobs === 0 &&
      data.partial_results === 0 &&
      (data.sample_finalized ||
        (data.collector_age_seconds !== null &&
          data.collector_age_seconds < 5400)) &&
      !data.bulk_refreshing;
    res
      .status(ready ? 200 : 503)
      .json({ status: ready ? "ok" : "degraded", ...data });
  })().catch((error) => {
    console.error(
      JSON.stringify({
        event: "analytics_readiness_failed",
        cause: String(error),
      }),
    );
    res
      .status(503)
      .json({ status: "degraded", reason: "database_unavailable" });
  });
};
