import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { prisma } from "../database/client.js";
import {
  benchmarkSchema,
  benchmarkSourceSchema,
  CALCULATION_VERSION,
  type Benchmark,
} from "./model.js";
import { AnalyticsError } from "./errors.js";

export type BenchmarkContext = {
  season: string;
  revision: string;
  snapshots: ReadonlyMap<number, Benchmark>;
};
const context = new AsyncLocalStorage<BenchmarkContext>();
export const withBenchmarks = <T>(value: BenchmarkContext, run: () => T): T =>
  context.run(value, run);
export const currentBenchmarks = (): BenchmarkContext | undefined =>
  context.getStore();
export const seasonState = async (
  options: {
    allowBulkRefresh?: boolean;
  } = {},
): Promise<{
  season: string;
  bulkRevision: string;
}> => {
  const rows = await prisma.$queryRaw<
    Array<{ key: string; value: string }>
  >`SELECT key,value FROM app_metadata WHERE key IN ('current_season','bulk_data_refresh_version','analytics_bulk_refresh_in_progress')`;
  if (
    !options.allowBulkRefresh &&
    rows.find((r) => r.key === "analytics_bulk_refresh_in_progress")?.value ===
      "1"
  )
    throw new AnalyticsError(
      "bulk_refresh_in_progress",
      "Player data is being refreshed. Saved analysis remains available.",
    );
  const season = rows.find((r) => r.key === "current_season")?.value;
  if (!season || !/^\d{4}-\d{2}$/.test(season))
    throw new AnalyticsError(
      "season_unavailable",
      "Current season data is not available yet.",
    );
  return {
    season,
    bulkRevision:
      rows.find((r) => r.key === "bulk_data_refresh_version")?.value ??
      "unknown",
  };
};
export const loadBenchmarks = async (
  start: number,
  end: number,
): Promise<BenchmarkContext> => {
  const pinned = currentBenchmarks();
  if (pinned) return pinned;
  const { season, bulkRevision } = await seasonState();
  // Published generations are immutable. This single statement captures a
  // consistent set of IDs and payloads, even during concurrent publication.
  const rows = await prisma.$queryRaw<Array<{ id: string; payload: unknown }>>`
    SELECT b.id,b.payload FROM analytics_publications p JOIN analytics_benchmarks b ON b.id=p.benchmark_id
    WHERE p.season=${season} AND p.gw BETWEEN ${start} AND ${end} AND b.calculation_version=${CALCULATION_VERSION} ORDER BY p.gw
  `;
  const snapshots = new Map<number, Benchmark>();
  for (const row of rows) {
    const snapshot = benchmarkSchema.parse(row.payload);
    snapshots.set(snapshot.gw, snapshot);
  }
  return {
    season,
    revision: createHash("sha256")
      .update(
        `${CALCULATION_VERSION}:${season}:${bulkRevision}:${rows.map((r) => r.id).join(":")}`,
      )
      .digest("hex"),
    snapshots,
  };
};
export const benchmarkFor = async (gw: number): Promise<Benchmark> => {
  const value = (await loadBenchmarks(gw, gw)).snapshots.get(gw);
  if (!value)
    throw new AnalyticsError(
      "benchmark_unavailable",
      `The published GW${gw} benchmark is not ready yet.`,
    );
  return value;
};
export const publishedRange = async (start: number, end: number) => {
  const snapshot = await benchmarkFor(end);
  const range = snapshot.ranges.find((r) => r.startGw === start);
  if (!range)
    throw new AnalyticsError(
      "range_unavailable",
      "This gameweek range is not published yet.",
    );
  return { snapshot, range };
};
export const publishBenchmark = async (
  candidate: Benchmark,
  source?: unknown,
  job?: Job,
  expectedPublicationId?: string,
  expectedAnchor?: { gw: number; id: string },
): Promise<string> => {
  const value = benchmarkSchema.parse(candidate),
    id = randomUUID();
  const compressed =
    source === undefined ? null : await promisify(gzip)(JSON.stringify(source));
  const followed =
    source && typeof source === "object" && "followedTop10k" in source
      ? benchmarkSourceSchema.shape.followedTop10k.parse(source.followedTop10k)
      : undefined;
  const followupPayload = followed ? JSON.stringify(followed) : null;
  if (
    value.ranges.length !== value.gw ||
    new Set(value.ranges.map((r) => r.startGw)).size !== value.gw ||
    value.ranges.some((r) => r.startGw > value.gw)
  )
    throw new Error("Incomplete benchmark range coverage");
  await prisma.$transaction(async (tx) => {
    if (expectedAnchor) {
      const anchor = await tx.$queryRaw<Array<{ benchmark_id: string }>>`
        SELECT benchmark_id FROM analytics_publications
        WHERE season=${value.season} AND gw=${expectedAnchor.gw} FOR SHARE`;
      if (anchor[0]?.benchmark_id !== expectedAnchor.id)
        throw new Error(
          "Anchor benchmark changed during follow-up collection; retry",
        );
    }
    if (expectedPublicationId) {
      const current = await tx.$queryRaw<Array<{ benchmark_id: string }>>`
        SELECT benchmark_id FROM analytics_publications
        WHERE season=${value.season} AND gw=${value.gw} FOR UPDATE`;
      if (current[0]?.benchmark_id !== expectedPublicationId)
        throw new Error("Benchmark changed during follow-up collection; retry");
    }
    if (job) {
      const lease = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM analytics_jobs WHERE id=${job.id}::uuid AND lease_token=${job.lease_token}::uuid AND status='running' FOR UPDATE`;
      if (!lease.length)
        throw new AnalyticsError(
          "lease_lost",
          "This benchmark build was superseded.",
          false,
        );
    }
    await tx.$executeRaw`INSERT INTO analytics_benchmarks(id,season,gw,calculation_version,source_revision,payload,source_payload,followup_payload) VALUES (${id}::uuid,${value.season},${value.gw},${CALCULATION_VERSION},${value.sourceRevision},${JSON.stringify(value)}::jsonb,${compressed},${followupPayload}::jsonb)`;
    await tx.$executeRaw`INSERT INTO analytics_publications(season,gw,benchmark_id) VALUES (${value.season},${value.gw},${id}::uuid) ON CONFLICT(season,gw) DO UPDATE SET benchmark_id=excluded.benchmark_id,published_at=now()`;
  });
  return id;
};

export const jobSchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  kind: z.enum(["benchmark", "manager"]),
  season: z.string(),
  entry_id: z.number().int().nullable(),
  start_gw: z.number().int(),
  end_gw: z.number().int(),
  attempts: z.number().int(),
  lease_token: z.string().uuid(),
});
export type Job = z.infer<typeof jobSchema>;
export const enqueue = async (input: {
  key: string;
  kind: Job["kind"];
  season: string;
  entry?: number;
  start: number;
  end: number;
}): Promise<void> => {
  // Failed jobs have an explicit retry delay. A live lease is never stolen by
  // polling; expired leases are reclaimed by the worker.
  await prisma.$executeRaw`INSERT INTO analytics_jobs(id,key,kind,season,entry_id,start_gw,end_gw) VALUES (${randomUUID()}::uuid,${input.key},${input.kind},${input.season},${input.entry ?? null},${input.start},${input.end})
    ON CONFLICT(key) DO UPDATE SET status='queued',attempts=0,error_code=null,error_message=null,available_at=now(),updated_at=now()
    WHERE analytics_jobs.status IN ('succeeded','failed') AND analytics_jobs.available_at <= now()`;
};
export const claimJob = async (benchmarksOnly = false): Promise<Job | null> => {
  const rows = await prisma.$queryRaw<unknown[]>`WITH candidate AS (
    SELECT id FROM analytics_jobs WHERE (${benchmarksOnly}=false OR kind='benchmark') AND ((status='queued' AND available_at<=now()) OR (status='running' AND lease_until<now()))
    ORDER BY CASE kind WHEN 'manager' THEN 0 ELSE 1 END,created_at FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE analytics_jobs j SET status='running',attempts=attempts+1,lease_token=${randomUUID()}::uuid,lease_until=now()+interval '90 seconds',heartbeat_at=now(),updated_at=now()
    FROM candidate c WHERE j.id=c.id RETURNING j.*`;
  return rows[0] ? jobSchema.parse(rows[0]) : null;
};
export const heartbeat = async (job: Job): Promise<boolean> =>
  (await prisma.$executeRaw`WITH owned AS (UPDATE analytics_jobs SET heartbeat_at=now(),lease_until=now()+interval '90 seconds' WHERE id=${job.id}::uuid AND lease_token=${job.lease_token}::uuid AND status='running' RETURNING id) INSERT INTO app_metadata(key,value) SELECT 'analytics_worker_heartbeat',${new Date().toISOString()} WHERE EXISTS(SELECT 1 FROM owned) ON CONFLICT(key) DO UPDATE SET value=excluded.value`) ===
  1;
export const finishJob = async (
  job: Job,
  error?: { code: string; message: string; retryable: boolean },
): Promise<void> => {
  const waiting =
    error?.code === "benchmark_unavailable" ||
    error?.code === "bulk_refresh_in_progress";
  const retry = Boolean(waiting || (error?.retryable && job.attempts < 3));
  await prisma.$executeRaw`UPDATE analytics_jobs SET status=${error ? (retry ? "queued" : "failed") : "succeeded"},attempts=GREATEST(0,attempts-${waiting ? 1 : 0}),error_code=${error?.code ?? null},error_message=${error?.message ?? null},available_at=now()+(${waiting ? 15 : error ? Math.min(300, 5 * 2 ** job.attempts) : 0}*interval '1 second'),lease_until=null,updated_at=now()
    WHERE id=${job.id}::uuid AND lease_token=${job.lease_token}::uuid AND status='running'`;
};
