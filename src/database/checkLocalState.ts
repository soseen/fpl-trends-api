import "dotenv/config";
import { prisma } from "./client.js";
import { benchmarkSchema, CALCULATION_VERSION } from "../analytics/model.js";

// Inspect serving state without scanning retired facts or recommending
// rebuilds of the obsolete cumulative/stratum tables.
try {
  const metadata = await prisma.app_metadata.findMany({
    where: {
      key: {
        in: [
          "current_season",
          "bulk_data_refresh_version",
          "analytics_bulk_refresh_in_progress",
          "analytics_worker_heartbeat",
          "analytics_last_collector_success",
          "manager_sample_gw",
          "manager_sample_gw_finalized",
          "manager_walk_cursor_version",
          "analytics_last_verified_export",
        ],
      },
    },
  });
  const state = Object.fromEntries(metadata.map((r) => [r.key, r.value]));
  const season = state["current_season"];
  const latest =
    (await prisma.events.aggregate({ _max: { id: true } }))._max.id ?? 0;
  const rows = await prisma.$queryRaw<
    Array<{ gw: number; payload: unknown; source_bytes: number }>
  >`
    SELECT p.gw,b.payload,COALESCE(octet_length(b.source_payload),0)::int AS source_bytes
    FROM analytics_publications p JOIN analytics_benchmarks b ON b.id=p.benchmark_id
    WHERE p.season=${season ?? ""} AND b.calculation_version=${CALCULATION_VERSION} ORDER BY p.gw`;
  const publications = rows.map((r) => {
    const b = benchmarkSchema.parse(r.payload);
    return {
      gw: r.gw,
      finalized: b.finalized,
      sourceManagers: b.sampleCounts,
      ranges: b.ranges.length,
      exposures: b.exposures.length,
      replayBytes: r.source_bytes,
      sparseTop10kRanges: b.ranges
        .filter((range) => range.cohorts.top10k.avg_total_points === null)
        .map((range) => range.startGw),
    };
  });
  const jobs = await prisma.$queryRaw<
    Array<{
      kind: string;
      status: string;
      count: number;
      oldest_seconds: number;
    }>
  >`
    SELECT kind,status,COUNT(*)::int count,EXTRACT(epoch FROM now()-MIN(updated_at))::int oldest_seconds
    FROM analytics_jobs WHERE season=${season ?? ""} GROUP BY kind,status ORDER BY kind,status`;
  const sizes = await prisma.$queryRaw<
    Array<{
      database_size: string;
      publications_size: string;
      results_size: string;
    }>
  >`
    SELECT pg_size_pretty(pg_database_size(current_database())) database_size,
      pg_size_pretty(pg_total_relation_size('analytics_benchmarks')) publications_size,
      pg_size_pretty(pg_total_relation_size('analytics_manager_results')) results_size`;
  const settings = await prisma.$queryRaw<
    Array<{ name: string; setting: string; unit: string | null }>
  >`
    SELECT name,setting,unit FROM pg_settings WHERE name IN ('statement_timeout','lock_timeout','work_mem','temp_file_limit') ORDER BY name`;
  console.info(
    JSON.stringify(
      {
        state,
        latestGameweek: latest,
        calculationVersion: CALCULATION_VERSION,
        publications,
        jobs,
        sizes: sizes[0],
        settings,
      },
      null,
      2,
    ),
  );
  if (
    !season ||
    rows.length !== latest ||
    rows.some((r) => r.source_bytes === 0)
  ) {
    console.error(
      "Published gameweek/replay coverage is incomplete. Run analytics:benchmarks and inspect the worker logs.",
    );
    process.exitCode = 1;
  }
  console.info(
    "Legacy cumulative/stratum aggregates are retired. Use analytics:replay, analytics:calibrate and /api/health/ready for release verification.",
  );
} catch (error) {
  console.error(
    "Analytics state inspection failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
