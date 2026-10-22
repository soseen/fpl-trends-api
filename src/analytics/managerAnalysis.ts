import { getManagerSummary } from "../managers/getManagerSummary.js";
import { getManagerTrajectory } from "../managers/getManagerTrajectory.js";
import { getRangeRank } from "../managers/getRangeRank.js";
import { getManagerComparison } from "../managers/getManagerComparison.js";
import { getTeamImpact } from "../managers/getTeamImpact.js";
import { getManagerTransfers } from "../managers/getManagerTransfers.js";
import { getCaptainImpact } from "../managers/getCaptainImpact.js";
import { prisma } from "../database/client.js";
import {
  loadBenchmarks,
  enqueue,
  withBenchmarks,
  seasonState,
  type Job,
} from "./store.js";
import { errorInfo, AnalyticsError } from "./errors.js";
import {
  ReadyAnalysisSchema,
  ManagerSummarySchema,
  ManagerTrajectorySchema,
  ManagerRangeRankSchema,
  ManagerComparisonSchema,
  TeamImpactSchema,
  ManagerTransfersSchema,
  CaptainImpactSchema,
} from "./contracts.generated.js";

const section = async <T>(
  loader: () => Promise<T>,
  validate: (value: T) => T,
) => {
  try {
    return { status: "ready" as const, data: validate(await loader()) };
  } catch (error) {
    const info = errorInfo(error);
    console.error(
      JSON.stringify({
        event: "analytics_section_failed",
        ...info,
        cause: error instanceof Error ? error.message : String(error),
      }),
    );
    return { status: "error" as const, error: info };
  }
};
const completePicks = <T extends { notes: { incomplete_picks: boolean } }>(
  value: T,
): T => {
  if (value.notes.incomplete_picks)
    throw new AnalyticsError(
      "incomplete_picks",
      "Some gameweek squads could not be loaded. Saved results remain available.",
    );
  return value;
};
export const prepareManager = async (job: Job): Promise<void> => {
  if (job.entry_id === null)
    throw new AnalyticsError(
      "invalid_job",
      "Manager job has no entry ID.",
      false,
    );
  const context = await loadBenchmarks(1, job.end_gw);
  if (context.season !== job.season)
    throw new AnalyticsError("season_changed", "The season changed.", false);
  const missing = Array.from({ length: job.end_gw }, (_, i) => i + 1).filter(
    (gw) => !context.snapshots.has(gw),
  );
  for (const gw of missing)
    await enqueue({
      key: `benchmark:${job.season}:${gw}`,
      kind: "benchmark",
      season: job.season,
      start: gw,
      end: gw,
    });
  if (missing.length)
    throw new AnalyticsError(
      "benchmark_unavailable",
      "Shared gameweek benchmarks are being prepared.",
    );
  const entry = job.entry_id,
    start = job.start_gw,
    end = job.end_gw;
  const before = await seasonState();
  const result = await withBenchmarks(context, async () => {
    // Validate identity before allowing seven sections to issue upstream work.
    const summary = ManagerSummarySchema.parse(await getManagerSummary(entry));
    if (summary.entry_id !== entry)
      throw new AnalyticsError(
        "identity_mismatch",
        "FPL returned a different manager.",
      );
    const [
      trajectory,
      rangeRank,
      comparison,
      teamImpact,
      transfers,
      captainImpact,
    ] = await Promise.all([
      section(
        () => getManagerTrajectory(entry),
        (value) => ManagerTrajectorySchema.parse(value),
      ),
      section(
        () => getRangeRank(entry, start, end),
        (value) => ManagerRangeRankSchema.parse(value),
      ),
      section(
        () => getManagerComparison(entry, start, end),
        (value) => ManagerComparisonSchema.parse(value),
      ),
      section(
        async () => completePicks(await getTeamImpact(entry, start, end)),
        (value) => TeamImpactSchema.parse(value),
      ),
      section(
        async () => {
          const transfers = completePicks(
            await getManagerTransfers(entry, start, end),
          );
          if (transfers.incomplete)
            throw new AnalyticsError(
              "incomplete_transfers",
              "Transfer history could not be refreshed.",
            );
          return transfers;
        },
        (value) => ManagerTransfersSchema.parse(value),
      ),
      section(
        async () => completePicks(await getCaptainImpact(entry, start, end)),
        (value) => CaptainImpactSchema.parse(value),
      ),
    ]);
    return ReadyAnalysisSchema.parse({
      state: "ready",
      season: job.season,
      entryId: entry,
      startGw: start,
      endGw: end,
      revision: context.revision,
      generatedAt: new Date().toISOString(),
      stale: false,
      sectionGeneratedAt: {},
      sectionErrors: {},
      sections: {
        summary: { status: "ready", data: summary },
        trajectory,
        rangeRank,
        comparison,
        teamImpact,
        transfers,
        captainImpact,
      },
    });
  });
  const checked = await prisma.events.count({
    where: { id: { gte: start, lte: end }, data_checked: true },
  });
  if (
    checked === end - start + 1 &&
    result.sections.teamImpact.status === "ready" &&
    !result.sections.teamImpact.data.notes.incomplete_picks &&
    result.sections.trajectory.status === "ready"
  ) {
    const trajectory = result.sections.trajectory.data.gws.filter(
      (g) => g.gw >= start && g.gw <= end,
    );
    const scored =
      result.sections.teamImpact.data.players.reduce(
        (sum, p) => sum + p.points_for_user,
        0,
      ) - trajectory.reduce((sum, g) => sum + g.event_transfers_cost, 0);
    if (scored !== result.sections.teamImpact.data.totals.user_range_points)
      result.sections.teamImpact = {
        status: "error",
        error: {
          code: "score_reconciliation_failed",
          message:
            "The finalized squad and official points do not reconcile yet.",
          retryable: true,
        },
      };
  }
  const previous = await prisma.$queryRaw<
    Array<{ payload: unknown }>
  >`SELECT payload FROM analytics_manager_results WHERE season=${job.season} AND entry_id=${entry} AND start_gw=${start} AND end_gw=${end}`;
  const old = ReadyAnalysisSchema.safeParse(previous[0]?.payload);
  for (const key of [
    "summary",
    "trajectory",
    "rangeRank",
    "comparison",
    "teamImpact",
    "transfers",
    "captainImpact",
  ] as const) {
    const value = result.sections[key];
    result.sectionGeneratedAt[key] = result.generatedAt;
    if (value.status === "error") {
      result.sectionErrors[key] = value.error;
      const saved = old.success ? old.data.sections[key] : undefined;
      if (saved?.status === "ready") {
        // Every key is validated by ReadyAnalysisSchema again below.
        Object.assign(result.sections, { [key]: saved });
        result.sectionGeneratedAt[key] = old.success
          ? (old.data.sectionGeneratedAt[key] ?? old.data.generatedAt)
          : result.generatedAt;
      }
    }
  }
  ReadyAnalysisSchema.parse(result);
  if ((await seasonState()).bulkRevision !== before.bulkRevision)
    throw new AnalyticsError(
      "bulk_refresh_in_progress",
      "Player data changed while analysis was preparing; it will be retried.",
    );
  const partial = Object.keys(result.sectionErrors).length > 0;
  await prisma.$transaction(async (tx) => {
    const lease = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM analytics_jobs WHERE id=${job.id}::uuid AND lease_token=${job.lease_token}::uuid AND status='running' FOR UPDATE`;
    if (!lease.length)
      throw new AnalyticsError(
        "lease_lost",
        "This preparation job was superseded.",
        false,
      );
    await tx.$executeRaw`INSERT INTO analytics_manager_results(season,entry_id,start_gw,end_gw,revision,payload,expires_at)
      VALUES (${job.season},${entry},${start},${end},${result.revision},${JSON.stringify(result)}::jsonb,now()+(${partial ? 30 : 300}*interval '1 second'))
      ON CONFLICT(season,entry_id,start_gw,end_gw) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,created_at=now(),expires_at=excluded.expires_at`;
  });
};
