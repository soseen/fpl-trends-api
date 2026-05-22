import { prisma } from "../database/client.js";

export type Stratum = 1 | 2 | 3;
export type ManagerSampleStatus = "final" | "refreshing" | "stale";

export const STRATUM_A_MAX = 10_000;
export const STRATUM_B_MAX = 100_000;
const STRATUM_C_MAX_FALLBACK = 15_000_000;
const ALL_STRATA: readonly Stratum[] = [1, 2, 3];
const SAMPLE_GW_KEY = "manager_sample_gw";
const SAMPLE_GW_FINALIZED_KEY = "manager_sample_gw_finalized";
const SAMPLE_GW_CLEANED_KEY = "manager_sample_gw_cleaned";

export const stratumCMax = async (): Promise<number> => {
  const row = await prisma.events.aggregate({
    _max: { ranked_count: true },
  });
  return row._max.ranked_count ?? STRATUM_C_MAX_FALLBACK;
};

export const rankedCountForGw = async (gw: number): Promise<number | null> => {
  const ev = await prisma.events.findUnique({
    where: { id: gw },
    select: { ranked_count: true },
  });
  return ev?.ranked_count ?? null;
};

const readIntMetadata = async (
  key: string,
  fallback: number,
): Promise<number> => {
  const rows = await prisma.$queryRaw<Array<{ value: string }>>`
    SELECT value FROM app_metadata WHERE key = ${key}
  `;
  const parsed = Number.parseInt(rows[0]?.value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export type ManagerSampleFreshness = {
  status: ManagerSampleStatus;
  finalized: boolean;
};

export const managerSampleFreshnessForEndGw = async (
  endGw: number,
): Promise<ManagerSampleFreshness> => {
  const event = await prisma.events.findFirst({
    where: {
      OR: [{ is_current: true }, { finished: true }],
    },
    select: { id: true, finished: true, is_current: true },
    orderBy: { id: "desc" },
  });

  if (!event || endGw !== event.id) {
    return { status: "final", finalized: true };
  }

  const [sampleGw, cleanedGw, finalizedState] = await Promise.all([
    readIntMetadata(SAMPLE_GW_KEY, 0),
    readIntMetadata(SAMPLE_GW_CLEANED_KEY, 0),
    readIntMetadata(SAMPLE_GW_FINALIZED_KEY, 0),
  ]);
  const isLiveCurrentGw = event.is_current && !event.finished;

  if (sampleGw !== event.id) {
    return { status: "stale", finalized: false };
  }

  if (isLiveCurrentGw) {
    return { status: "refreshing", finalized: false };
  }

  if (cleanedGw !== event.id) {
    return { status: "stale", finalized: false };
  }

  if (finalizedState === 1) {
    return { status: "final", finalized: true };
  }

  return { status: "refreshing", finalized: false };
};

export const pickStratum = (
  overallRank: number | null,
  cMax: number,
): Stratum | null => {
  if (overallRank === null) return null;
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
    1: STRATUM_A_MAX,
    2: STRATUM_B_MAX - STRATUM_A_MAX,
    3: Math.max(effectiveCMax - STRATUM_B_MAX, 1),
  };
};

type BucketAggregateRow = {
  stratum: number;
  sample_size: bigint | number | null;
  higher: bigint | number | null;
  total_points: bigint | number | null;
};

const toNumber = (value: bigint | number | null | undefined): number =>
  typeof value === "bigint" ? Number(value) : (value ?? 0);

export type RangeEstimate = {
  rangeRank: number | null;
  sampleSizeByStratum: Record<Stratum, number>;
};

export const estimateRangeRankFromBuckets = async (
  startGw: number,
  endGw: number,
  threshold: number,
): Promise<RangeEstimate> => {
  const [rows, trueSize, rankedAtEnd] = await Promise.all([
    prisma.$queryRawUnsafe<BucketAggregateRow[]>(
      `
      SELECT
        stratum,
        SUM(managers)::bigint AS sample_size,
        SUM(managers) FILTER (WHERE range_total >= $3)::bigint AS higher,
        SUM((range_total::bigint * managers::bigint))::bigint AS total_points
      FROM manager_range_score_buckets
      WHERE start_gw = $1 AND end_gw = $2
      GROUP BY stratum
      `,
      startGw,
      endGw,
      threshold,
    ),
    trueStratumSizes(endGw),
    rankedCountForGw(endGw),
  ]);

  const sampleSizeByStratum: Record<Stratum, number> = { 1: 0, 2: 0, 3: 0 };
  if (rows.length === 0) {
    return { rangeRank: null, sampleSizeByStratum };
  }

  let totalHigher = 0;
  for (const row of rows) {
    if (!ALL_STRATA.includes(row.stratum as Stratum)) continue;
    const stratum = row.stratum as Stratum;
    const sampleSize = toNumber(row.sample_size);
    const higher = toNumber(row.higher);
    sampleSizeByStratum[stratum] = sampleSize;
    if (sampleSize === 0) continue;
    totalHigher += Math.round((higher * trueSize[stratum]) / sampleSize);
  }

  const cap = rankedAtEnd ?? Number.MAX_SAFE_INTEGER;
  return {
    rangeRank: Math.max(1, Math.min(totalHigher + 1, cap)),
    sampleSizeByStratum,
  };
};

export type RangeDensity = {
  rankPerPoint: number | null;
  stratumAverage: number | null;
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
  halfWindow: number,
): Promise<RangeDensity> => {
  if (stratum === null || userOverallTotal === null) {
    return { rankPerPoint: null, stratumAverage: null };
  }
  const lo = userOverallTotal - halfWindow;
  const hi = userOverallTotal + halfWindow;
  const startMinusOne = startGw - 1;

  const [densityRows, averageRows, trueSize] = await Promise.all([
    prisma.$queryRawUnsafe<
      Array<{
        neighbours: bigint | number | null;
      }>
    >(
      `
      SELECT
        COUNT(*)::bigint AS neighbours
      FROM manager_cumulative c_end
      WHERE c_end.stratum = $1
        AND c_end.gw = $3
        AND c_end.cumulative_points BETWEEN $4 AND $5
      `,
      stratum,
      startGw,
      endGw,
      lo,
      hi,
    ),
    prisma.$queryRawUnsafe<
      Array<{
        sample_size: number | null;
        sum_range_total: bigint | number | null;
      }>
    >(
      `
      SELECT
        e.sample_size,
        e.sum_cum_points - COALESCE(s.sum_cum_points, 0)::bigint
          AS sum_range_total
      FROM stratum_gw_running_stats e
      LEFT JOIN stratum_gw_running_stats s
        ON s.stratum = e.stratum AND s.gw = $2
      WHERE e.stratum = $1 AND e.gw = $3
      `,
      stratum,
      startMinusOne,
      endGw,
    ),
    trueStratumSizes(endGw),
  ]);

  const averageRow = averageRows[0];
  const sampleSize = averageRow?.sample_size ?? 0;
  if (!averageRow || sampleSize === 0) {
    return { rankPerPoint: null, stratumAverage: null };
  }

  const neighbours = toNumber(densityRows[0]?.neighbours);
  const sumRangeTotal = toNumber(averageRow.sum_range_total);
  const density = neighbours / Math.max(1, 2 * halfWindow);
  const extrapolation = trueSize[stratum] / sampleSize;
  const rankPerPoint = density * extrapolation;

  return {
    rankPerPoint: rankPerPoint > 0 ? rankPerPoint : null,
    stratumAverage: sumRangeTotal / sampleSize,
  };
};
