import { prisma } from "../database/client.js";
import { fetchEntryHistory } from "./fetchManager.js";
import { netPointsForEvent } from "./activityFilter.js";

type ChipPlay = { chip_name: string; num_played: number };

export type ComparisonStat = {
  user: number;
  average: number | null;
};

export type ManagerComparisonResponse = {
  entry_id: number;
  start_gw: number;
  end_gw: number;
  total_points: ComparisonStat;
  transfers: ComparisonStat;
  // Chip stats: user is 0 or 1 (played within range or not). Average is the
  // fraction of FPL managers (0..1) who played that chip in the range.
  wildcards: ComparisonStat;
  free_hits: ComparisonStat;
  bench_boosts: ComparisonStat;
  hits: ComparisonStat;
  bench_points: ComparisonStat;
  notes: {
    hits_average_partial: boolean;
    bench_average_partial: boolean;
  };
};

const CHIP_NAME_WILDCARD = "wildcard";
const CHIP_NAME_FREEHIT = "freehit";
const CHIP_NAME_BBOOST = "bboost";

const sumChipPlays = (
  chipPlays: ChipPlay[] | null | undefined,
  chipName: string,
): number => {
  if (!chipPlays) return 0;
  const entry = chipPlays.find((c) => c.chip_name === chipName);
  return entry?.num_played ?? 0;
};

export const getManagerComparison = async (
  entryId: number,
  startGw: number,
  endGw: number,
): Promise<ManagerComparisonResponse> => {
  const history = await fetchEntryHistory(entryId);

  const eventsInRange = history.current.filter(
    (ev) => ev.event >= startGw && ev.event <= endGw,
  );

  // ---- User-side aggregates from the FPL history payload (one fetch).
  const userTotalPoints = eventsInRange.reduce(
    (acc, ev) => acc + netPointsForEvent(ev),
    0,
  );
  const userTransfers = eventsInRange.reduce(
    (acc, ev) => acc + ev.event_transfers,
    0,
  );
  const userHits = eventsInRange.reduce(
    (acc, ev) => acc + Math.floor(ev.event_transfers_cost / 4),
    0,
  );
  const userBench = eventsInRange.reduce(
    (acc, ev) => acc + ev.points_on_bench,
    0,
  );

  const chipsPlayedInRange = (history.chips ?? []).filter(
    (c) => c.event >= startGw && c.event <= endGw,
  );
  const userWildcard = chipsPlayedInRange.some(
    (c) => c.name === CHIP_NAME_WILDCARD,
  )
    ? 1
    : 0;
  const userFreeHit = chipsPlayedInRange.some(
    (c) => c.name === CHIP_NAME_FREEHIT,
  )
    ? 1
    : 0;
  const userBenchBoost = chipsPlayedInRange.some(
    (c) => c.name === CHIP_NAME_BBOOST,
  )
    ? 1
    : 0;

  // ---- Per-event aggregates from our DB (cheap; one query covers 1–38 rows).
  const events = await prisma.events.findMany({
    where: { id: { gte: startGw, lte: endGw }, finished: true },
    select: {
      id: true,
      average_entry_score: true,
      transfers_made: true,
      ranked_count: true,
      chip_plays: true,
    },
  });

  let avgTotalPoints = 0;
  let avgTransfersTotal = 0;
  let avgWildcardRate = 0;
  let avgFreeHitRate = 0;
  let avgBenchBoostRate = 0;

  for (const ev of events) {
    avgTotalPoints += ev.average_entry_score;
    if (ev.ranked_count > 0) {
      avgTransfersTotal += ev.transfers_made / ev.ranked_count;
      const cp = ev.chip_plays as ChipPlay[] | null;
      avgWildcardRate += sumChipPlays(cp, CHIP_NAME_WILDCARD) / ev.ranked_count;
      avgFreeHitRate += sumChipPlays(cp, CHIP_NAME_FREEHIT) / ev.ranked_count;
      avgBenchBoostRate += sumChipPlays(cp, CHIP_NAME_BBOOST) / ev.ranked_count;
    }
  }

  // ---- Phase 2 averages from sampled manager_history.
  // Aggregate first by entry (sum within range), then average across entries.
  // Use COALESCE so legacy rows (null cost / null bench) don't poison sums.
  const phase2 = await prisma.$queryRaw<
    Array<{
      avg_hits: number | null;
      avg_bench: number | null;
      sample_size: number;
      with_hits_data: number;
      with_bench_data: number;
    }>
  >`
    SELECT
      AVG(hits)::float AS avg_hits,
      AVG(bench)::float AS avg_bench,
      COUNT(*)::int AS sample_size,
      SUM(CASE WHEN has_hits THEN 1 ELSE 0 END)::int AS with_hits_data,
      SUM(CASE WHEN has_bench THEN 1 ELSE 0 END)::int AS with_bench_data
    FROM (
      SELECT
        mh.entry_id,
        SUM(COALESCE(mh.event_transfers_cost, 0)) / 4.0 AS hits,
        SUM(COALESCE(mh.points_on_bench, 0)) AS bench,
        BOOL_OR(mh.event_transfers_cost IS NOT NULL) AS has_hits,
        BOOL_OR(mh.points_on_bench IS NOT NULL) AS has_bench
      FROM manager_history mh
      JOIN manager_summary ms ON ms.entry_id = mh.entry_id
      WHERE mh.gw BETWEEN ${startGw} AND ${endGw}
        AND ms.rejected_reason IS NULL
      GROUP BY mh.entry_id
    ) t
  `;

  const row = phase2[0];
  const sampleSize = row?.sample_size ?? 0;
  const withHits = row?.with_hits_data ?? 0;
  const withBench = row?.with_bench_data ?? 0;
  const hitsCoverage = sampleSize > 0 ? withHits / sampleSize : 0;
  const benchCoverage = sampleSize > 0 ? withBench / sampleSize : 0;

  // Average is reliable only when at least half of sampled managers in the
  // range have non-null values. While backfill is in flight, surface a partial
  // flag so the UI can mark it approximate.
  const COVERAGE_THRESHOLD = 0.5;
  const avgHits =
    sampleSize > 0 && withHits > 0 && hitsCoverage >= COVERAGE_THRESHOLD
      ? (row?.avg_hits ?? null)
      : null;
  const avgBench =
    sampleSize > 0 && withBench > 0 && benchCoverage >= COVERAGE_THRESHOLD
      ? (row?.avg_bench ?? null)
      : null;

  return {
    entry_id: entryId,
    start_gw: startGw,
    end_gw: endGw,
    total_points: { user: userTotalPoints, average: avgTotalPoints },
    transfers: { user: userTransfers, average: avgTransfersTotal },
    wildcards: { user: userWildcard, average: avgWildcardRate },
    free_hits: { user: userFreeHit, average: avgFreeHitRate },
    bench_boosts: { user: userBenchBoost, average: avgBenchBoostRate },
    hits: { user: userHits, average: avgHits },
    bench_points: { user: userBench, average: avgBench },
    notes: {
      hits_average_partial: avgHits !== null && hitsCoverage < 1,
      bench_average_partial: avgBench !== null && benchCoverage < 1,
    },
  };
};
