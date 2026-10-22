import { publishedRange, benchmarkFor } from "../analytics/store.js";
import { populationSizes } from "../analytics/model.js";
import { rankedPopulationSql } from "./rankedPopulation.js";
import { prisma } from "../database/client.js";
import {
  createRankMovementEstimator,
  type RankMovementEstimator,
} from "./rankMovement.js";

export type Stratum = 1 | 2 | 3;
export type ManagerSampleStatus = "final" | "refreshing" | "stale";

export const STRATUM_A_MAX = 10_000;
export const STRATUM_B_MAX = 100_000;
const STRATUM_C_MAX_FALLBACK = 15_000_000;
const ALL_STRATA: readonly Stratum[] = [1, 2, 3];

export const stratumCMax = async (): Promise<number> => {
  const row = await prisma.events.aggregate({
    _max: { ranked_count: true },
  });
  return row._max.ranked_count && row._max.ranked_count > 0
    ? row._max.ranked_count
    : STRATUM_C_MAX_FALLBACK;
};

export const rankedCountForGw = async (gw: number): Promise<number | null> => {
  const rows = await prisma.$queryRawUnsafe<Array<{ population: number }>>(
    `SELECT ${rankedPopulationSql("e")} AS population FROM events e WHERE e.id = $1`,
    gw,
  );
  return rows[0]?.population ?? null;
};

export type ManagerSampleFreshness = {
  status: ManagerSampleStatus;
  finalized: boolean;
};

export const managerSampleFreshnessForEndGw = async (
  endGw: number,
): Promise<ManagerSampleFreshness> => {
  try {
    const snapshot = await benchmarkFor(endGw);
    return {
      status: snapshot.finalized ? "final" : "refreshing",
      finalized: snapshot.finalized,
    };
  } catch {
    return { status: "stale", finalized: false };
  }
};

export const pickStratum = (
  overallRank: number | null,
  cMax: number,
): Stratum | null => {
  if (overallRank === null || overallRank <= 0) return null;
  if (overallRank <= STRATUM_A_MAX) return 1;
  if (overallRank <= STRATUM_B_MAX) return 2;
  if (overallRank <= cMax) return 3;
  return null;
};

export const trueStratumSizes = async (
  endGw: number,
): Promise<Record<Stratum, number>> => {
  const [rankedAtEnd, cMax] = await Promise.all([
    rankedCountForGw(endGw),
    stratumCMax(),
  ]);
  const effectiveCMax = rankedAtEnd ?? cMax;
  return {
    1: Math.min(effectiveCMax, STRATUM_A_MAX),
    2: Math.max(Math.min(effectiveCMax, STRATUM_B_MAX) - STRATUM_A_MAX, 0),
    3: Math.max(effectiveCMax - STRATUM_B_MAX, 0),
  };
};

type BucketAggregateRow = {
  stratum: number;
  sample_size: bigint | number | null;
  strictly_higher: bigint | number | null;
  tied: bigint | number | null;
};

const toNumber = (value: bigint | number | null | undefined): number =>
  typeof value === "bigint" ? Number(value) : (value ?? 0);

export type RangeEstimate = {
  rangeRank: number | null;
  sampleSizeByStratum: Record<Stratum, number>;
};

export const estimateWeightedMidrank = (
  rows: ReadonlyArray<BucketAggregateRow>,
  trueSize: Record<Stratum, number>,
  rankedAtEnd: number | null,
): RangeEstimate => {
  const sampleSizeByStratum: Record<Stratum, number> = { 1: 0, 2: 0, 3: 0 };
  if (rows.length === 0) return { rangeRank: null, sampleSizeByStratum };

  let managersAhead = 0;
  for (const row of rows) {
    if (!ALL_STRATA.includes(row.stratum as Stratum)) continue;
    const stratum = row.stratum as Stratum;
    const sampleSize = toNumber(row.sample_size);
    sampleSizeByStratum[stratum] = sampleSize;
    if (sampleSize === 0) continue;

    const strictlyHigher = toNumber(row.strictly_higher);
    const tied = toNumber(row.tied);
    const sampleMidrankAhead = strictlyHigher + tied / 2;
    managersAhead += (sampleMidrankAhead * trueSize[stratum]) / sampleSize;
  }

  if (ALL_STRATA.some((s) => trueSize[s] > 0 && sampleSizeByStratum[s] === 0))
    return { rangeRank: null, sampleSizeByStratum };
  const cap = rankedAtEnd ?? Number.MAX_SAFE_INTEGER;
  return {
    rangeRank: Math.max(1, Math.min(Math.round(managersAhead + 1), cap)),
    sampleSizeByStratum,
  };
};

export const estimateRangeRankFromBuckets = async (
  startGw: number,
  endGw: number,
  threshold: number,
): Promise<RangeEstimate> => {
  const { snapshot, range } = await publishedRange(startGw, endGw);
  const rows = ALL_STRATA.map((stratum) => {
    const buckets = range.buckets.filter((b) => b.stratum === stratum);
    return {
      stratum,
      sample_size: buckets.reduce((n, b) => n + b.managers, 0),
      strictly_higher: buckets
        .filter((b) => b.score > threshold)
        .reduce((n, b) => n + b.managers, 0),
      tied: buckets
        .filter((b) => b.score === threshold)
        .reduce((n, b) => n + b.managers, 0),
    };
  });
  return estimateWeightedMidrank(
    rows,
    populationSizes(snapshot.population),
    snapshot.population,
  );
};

export type RangeDensity = {
  rankPerPoint: number | null;
  stratumAverage: number | null;
};

export type RankCurveSource =
  | "standings_snapshot"
  | "recent_manager_sample"
  | "final_manager_sample";

export type RankCurveStatus =
  | "live"
  | "refreshing"
  | "final"
  | "provisional"
  | "stale"
  | "unavailable";

export type RankMovementCurve = {
  estimator: RankMovementEstimator | null;
  source: RankCurveSource | null;
  status: RankCurveStatus;
  capturedAt: Date | null;
};

const LIVE_SNAPSHOT_STALE_AFTER_MS = 45 * 60 * 1000;
export const overallRankMovementCurve = async (
  endGw: number,
): Promise<RankMovementCurve> => {
  const [snapshot, event, population] = await Promise.all([
    prisma.overall_rank_curve_snapshots.findUnique({
      where: { gw: endGw },
      include: { points: { orderBy: { score: "asc" } } },
    }),
    prisma.events.findUnique({
      where: { id: endGw },
      select: { finished: true, data_checked: true, is_current: true },
    }),
    rankedCountForGw(endGw),
  ]);
  if (
    snapshot &&
    snapshot.max_rank >=
      Math.floor((population ?? Number.MAX_SAFE_INTEGER) * 0.9)
  ) {
    const estimator = createRankMovementEstimator(snapshot.points);
    if (estimator) {
      const stale =
        !snapshot.is_final &&
        !event?.finished &&
        Date.now() - snapshot.captured_at.getTime() >
          LIVE_SNAPSHOT_STALE_AFTER_MS;
      return {
        estimator,
        source: "standings_snapshot",
        status: snapshot.is_final
          ? "final"
          : stale
            ? "stale"
            : event?.finished
              ? "refreshing"
              : "live",
        capturedAt: snapshot.captured_at,
      };
    }
  }
  // Finalized fallback curves are calculated once by the benchmark worker.
  // Never scan manager facts in an HTTP/manager-render path.
  try {
    const benchmark = await benchmarkFor(endGw);
    if (benchmark.finalized && benchmark.curve) {
      const estimator = createRankMovementEstimator(benchmark.curve.points);
      if (estimator)
        return {
          estimator,
          source: "final_manager_sample",
          status: "final",
          capturedAt: new Date(benchmark.curve.capturedAt),
        };
    }
  } catch {
    /* Missing publication is an explicit unavailable estimate. */
  }
  return {
    estimator: null,
    source: null,
    status: "unavailable",
    capturedAt: null,
  };
};

export const overallRankMovementEstimator = async (
  endGw: number,
): Promise<RankMovementEstimator | null> => {
  const curve = await overallRankMovementCurve(endGw);
  return curve.estimator;
};

// Density of OVERALL season totals at the user's overall total (at end_gw)
// within their stratum, plus the stratum's average RANGE total.
//
// rank_per_point: gaining +1 range point = +1 overall point, so the rank
// movement is governed by the local density of overall totals around the
// user's overall total. The earlier implementation read from
// manager_range_score_buckets (range totals); for short ranges the range
// distribution is much narrower than overall totals, which inflated the
// coefficient by ≈ √(38 / N_range_gws). Querying manager_cumulative at
// end_gw gives the correct local density.
//
// stratumAverage: average of (cumulative_at_end − cumulative_at_start_minus_1)
// per manager — i.e. the average range total. Display-only on the response;
// independent of rank_per_point math.
export const rangeDensityFromCumulative = async (
  stratum: Stratum | null,
  startGw: number,
  endGw: number,
  userOverallTotal: number | null,
  _halfWindow: number,
): Promise<RangeDensity> => {
  if (stratum === null || userOverallTotal === null)
    return { rankPerPoint: null, stratumAverage: null };
  const [{ range }, curve] = await Promise.all([
    publishedRange(startGw, endGw),
    overallRankMovementCurve(endGw),
  ]);
  return {
    stratumAverage: range.stratumAverages[stratum - 1] ?? null,
    rankPerPoint: curve.estimator?.impactForExcess(userOverallTotal, 1) ?? null,
  };
};
