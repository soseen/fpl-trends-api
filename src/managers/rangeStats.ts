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
  const [rows, trueSize, rankedAtEnd] = await Promise.all([
    prisma.$queryRawUnsafe<BucketAggregateRow[]>(
      `
      SELECT
        stratum,
        SUM(managers)::bigint AS sample_size,
        SUM(managers) FILTER (WHERE range_total > $3)::bigint AS strictly_higher,
        SUM(managers) FILTER (WHERE range_total = $3)::bigint AS tied
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

  return estimateWeightedMidrank(rows, trueSize, rankedAtEnd);
};

export type RangeDensity = {
  rankPerPoint: number | null;
  stratumAverage: number | null;
};

type OverallRankMilestoneRow = {
  score: number;
  rank: number;
  sample_size?: number;
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
const RECENT_MANAGER_SAMPLE_MIN_MILESTONES = 5;
const RECENT_MANAGER_SAMPLE_MIN_MANAGERS = 100;

const finalManagerSampleEstimator = async (
  endGw: number,
): Promise<RankMovementEstimator | null> => {
  const latest = await prisma.manager_cumulative.aggregate({
    _max: { gw: true },
  });
  const canUseCurrentRankFallback = latest._max.gw === endGw;
  const rows = await prisma.$queryRawUnsafe<OverallRankMilestoneRow[]>(
    `
    WITH ranked_managers AS (
      SELECT
        mc.cumulative_points AS score,
        COALESCE(
          mh.overall_rank,
          CASE WHEN $2::boolean THEN ms.overall_rank ELSE NULL END
        ) AS official_rank
      FROM manager_cumulative mc
      JOIN manager_summary ms ON ms.entry_id = mc.entry_id
      LEFT JOIN manager_history mh
        ON mh.entry_id = mc.entry_id AND mh.gw = mc.gw
      WHERE mc.gw = $1
    )
    SELECT
      score,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY official_rank)::float AS rank
    FROM ranked_managers
    WHERE official_rank > 0
    GROUP BY score
    ORDER BY score
    `,
    endGw,
    canUseCurrentRankFallback,
  );

  return createRankMovementEstimator(rows);
};

const recentManagerSampleCurve = async (
  endGw: number,
): Promise<RankMovementCurve> => {
  const [rows, latest] = await Promise.all([
    prisma.$queryRawUnsafe<OverallRankMilestoneRow[]>(
      `
      WITH latest AS (
        SELECT MAX(last_updated) AS captured_at
        FROM manager_summary
        WHERE last_checked_gw = $1
          AND last_updated >= NOW() - INTERVAL '45 minutes'
      )
      SELECT
        ms.total_points AS score,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ms.overall_rank)::float AS rank,
        COUNT(*)::int AS sample_size
      FROM manager_summary ms
      CROSS JOIN latest
      WHERE ms.last_checked_gw = $1
        AND latest.captured_at IS NOT NULL
        AND ms.last_updated >= latest.captured_at - INTERVAL '10 minutes'
        AND ms.total_points IS NOT NULL
        AND ms.overall_rank > 0
      GROUP BY ms.total_points
      ORDER BY ms.total_points
      `,
      endGw,
    ),
    prisma.manager_summary.aggregate({
      where: {
        last_checked_gw: endGw,
        last_updated: {
          gte: new Date(Date.now() - LIVE_SNAPSHOT_STALE_AFTER_MS),
        },
      },
      _max: { last_updated: true },
    }),
  ]);
  const sampleSize = rows.reduce(
    (total, row) => total + (row.sample_size ?? 0),
    0,
  );
  if (
    rows.length < RECENT_MANAGER_SAMPLE_MIN_MILESTONES ||
    sampleSize < RECENT_MANAGER_SAMPLE_MIN_MANAGERS
  ) {
    return {
      estimator: null,
      source: null,
      status: "unavailable",
      capturedAt: null,
    };
  }
  return {
    estimator: createRankMovementEstimator(rows),
    source: "recent_manager_sample",
    status: "provisional",
    capturedAt: latest._max.last_updated,
  };
};

// Overall-rank movement is non-linear: four points can cross far more teams
// than four times a one-point estimate. During a live GW, always prefer the
// independently captured Overall-league snapshot: manager_history is updated
// throughout the weekend and mixing those rows produces a curve that never
// existed at any one moment. A recent manager_summary slice is a live-safe
// fallback. Each score/rank pair originates in the same standings row and the
// fallback is limited to a tight ten-minute capture window.
export const overallRankMovementCurve = async (
  endGw: number,
): Promise<RankMovementCurve> => {
  const [snapshot, event] = await Promise.all([
    prisma.overall_rank_curve_snapshots.findUnique({
      where: { gw: endGw },
      include: { points: { orderBy: { score: "asc" } } },
    }),
    prisma.events.findUnique({
      where: { id: endGw },
      select: { finished: true, is_current: true },
    }),
  ]);

  if (snapshot) {
    const estimator = createRankMovementEstimator(snapshot.points);
    if (estimator !== null) {
      const ageMs = Date.now() - snapshot.captured_at.getTime();
      const status: RankCurveStatus = snapshot.is_final
        ? "final"
        : event?.finished
          ? "refreshing"
          : ageMs <= LIVE_SNAPSHOT_STALE_AFTER_MS
            ? "live"
            : "stale";
      if (status !== "stale") {
        return {
          estimator,
          source: "standings_snapshot",
          status,
          capturedAt: snapshot.captured_at,
        };
      }

      const recent = await recentManagerSampleCurve(endGw);
      if (recent.estimator !== null) return recent;
      return {
        estimator,
        source: "standings_snapshot",
        status,
        capturedAt: snapshot.captured_at,
      };
    }
  }

  if (event?.is_current && !event.finished) {
    const recent = await recentManagerSampleCurve(endGw);
    if (recent.estimator !== null) return recent;
    // Never fall through to the all-time manager sample during a live GW.
    // Those rows are refreshed at different times, so combining them would
    // recreate the incoherent curve this snapshot model is designed to avoid.
    return recent;
  }

  const estimator = await finalManagerSampleEstimator(endGw);
  return {
    estimator,
    source: estimator === null ? null : "final_manager_sample",
    status:
      estimator === null
        ? "unavailable"
        : event?.finished
          ? "final"
          : "provisional",
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
