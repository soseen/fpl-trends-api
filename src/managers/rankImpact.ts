import { fetchLiveManagerHistory } from "./liveManagerHistory.js";
import { readCaptainRates } from "../analytics/readers.js";
import { rankedPopulationSql } from "./rankedPopulation.js";
import { prisma } from "../database/client.js";
import type { PlayerHistory } from "../types.js";
import { netPointsForEvent } from "./activityFilter.js";
import { fetchEntrySummary } from "./fetchManager.js";
import {
  overallRankMovementEstimator,
  pickStratum,
  rangeDensityFromCumulative,
  stratumCMax,
  type Stratum,
} from "./rangeStats.js";
import { pickRankBand, type RankBand } from "./rankBands.js";
import type { RankMovementEstimator } from "./rankMovement.js";

export const RANK_DENSITY_HALF_WINDOW = 25;
export const SMALL_CAPTAIN_SAMPLE_THRESHOLD = 50;

export type RankImpactContext = {
  user_range_points: number;
  stratum: Stratum | null;
  comparison_band_by_gw: ReadonlyMap<number, RankBand | 0 | null>;
  stratum_avg_range_points: number | null;
  rank_per_point: number | null;
  user_overall_total: number | null;
  estimator: RankMovementEstimator | null;
};

export type PlayerGwRankStat = {
  total_points: number;
  selected: number;
  ranked_count: number;
};

export type CaptainRate = {
  cap_rate: number;
  tc_rate: number;
};

export type CaptainRateInfo = {
  rates: Map<string, CaptainRate>;
  perGwSampleSize: Map<number, number>;
};

export const playerGwKey = (playerId: number, gw: number): string =>
  `${playerId}:${gw}`;

export const ownershipPct = (stat: PlayerGwRankStat | undefined): number => {
  if (!stat || stat.ranked_count <= 0) return 0;
  return Math.min(stat.selected / stat.ranked_count, 1);
};

export const resolveRankImpactContext = async (
  entryId: number,
  startGw: number,
  endGw: number,
  history?: PlayerHistory,
): Promise<RankImpactContext> => {
  const [summary, resolvedHistory, cMax] = await Promise.all([
    fetchEntrySummary(entryId),
    history ? Promise.resolve(history) : fetchLiveManagerHistory(entryId),
    stratumCMax(),
  ]);

  const eventsInRange = (resolvedHistory.current ?? []).filter(
    (ev) => ev.event >= startGw && ev.event <= endGw,
  );
  const userRangePoints = eventsInRange.reduce(
    (acc, ev) => acc + netPointsForEvent(ev),
    0,
  );

  const rangeEndEvent = eventsInRange.find((ev) => ev.event === endGw);
  const rangeEndOverallRank =
    rangeEndEvent?.overall_rank ?? summary.summary_overall_rank;
  // Cumulative season total at end_gw — used for density(overall_total) so
  // that rank_per_point reflects how many managers are within ±halfWindow of
  // the user in the OVERALL standings (which is what governs rank movement
  // when the user gains range points).
  const userOverallTotal =
    rangeEndEvent?.total_points ?? summary.summary_overall_points;
  const stratum = pickStratum(rangeEndOverallRank, cMax);
  const [density, estimator] = await Promise.all([
    rangeDensityFromCumulative(
      stratum,
      startGw,
      endGw,
      userOverallTotal,
      RANK_DENSITY_HALF_WINDOW,
    ),
    overallRankMovementEstimator(endGw),
  ]);
  const rankPerPoint =
    estimator !== null && userOverallTotal !== null
      ? estimator.impactForExcess(userOverallTotal, 1)
      : null;
  const historicalRankByGw = new Map(
    (resolvedHistory.current ?? []).map((event) => [
      event.event,
      event.overall_rank,
    ]),
  );
  const comparisonBandByGw = new Map<number, RankBand | 0 | null>();
  for (let gw = startGw; gw <= endGw; gw += 1) {
    comparisonBandByGw.set(
      gw,
      gw === 1 ? 0 : pickRankBand(historicalRankByGw.get(gw - 1)),
    );
  }

  return {
    user_range_points: userRangePoints,
    stratum,
    comparison_band_by_gw: comparisonBandByGw,
    stratum_avg_range_points: density.stratumAverage,
    rank_per_point:
      rankPerPoint !== null && rankPerPoint > 0 ? rankPerPoint : null,
    user_overall_total: userOverallTotal,
    estimator,
  };
};

export const rankImpactForPoints = (
  context: RankImpactContext,
  points: number,
): number | null => {
  if (context.estimator === null || context.user_overall_total === null) {
    return null;
  }
  return context.estimator.impactForExcess(context.user_overall_total, points);
};

export const fetchPlayerGwRankStats = async (
  playerIds: ReadonlyArray<number>,
  startGw: number,
  endGw: number,
): Promise<Map<string, PlayerGwRankStat>> => {
  const map = new Map<string, PlayerGwRankStat>();
  if (playerIds.length === 0 || startGw > endGw) return map;

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      footballer_id: number;
      round: number;
      total_points: number;
      selected: number;
      ranked_count: number;
    }>
  >(
    `
    SELECT
      h.footballer_id,
      h.round,
      SUM(h.total_points)::int AS total_points,
      MAX(h.selected)::int AS selected,
      COALESCE(MAX(${rankedPopulationSql("e")}), 0)::int AS ranked_count
    FROM history h
    LEFT JOIN events e ON e.id = h.round
    WHERE h.footballer_id = ANY($1::int[])
      AND h.round BETWEEN $2 AND $3
    GROUP BY h.footballer_id, h.round
    `,
    [...playerIds],
    startGw,
    endGw,
  );

  for (const r of rows) {
    map.set(playerGwKey(r.footballer_id, r.round), {
      total_points: r.total_points,
      selected: r.selected,
      ranked_count: r.ranked_count,
    });
  }

  return map;
};

export const fetchCaptainRatesInStratum = async (
  _stratum: Stratum | null,
  start: number,
  end: number,
): Promise<CaptainRateInfo> =>
  readCaptainRates(
    new Map(
      Array.from(
        { length: end - start + 1 },
        (_, i) => [start + i, 0] as const,
      ),
    ),
    start,
    end,
  );

export const fetchCaptainRatesInRankBand = readCaptainRates;

export const captainExpectedBonus = (
  gw: number,
  captainInfo: CaptainRateInfo,
  stats: Map<string, PlayerGwRankStat>,
): number | null => {
  const sampleSize = captainInfo.perGwSampleSize.get(gw) ?? 0;
  if (sampleSize === 0) return null;

  let expected = 0;
  const suffix = `:${gw}`;
  for (const [key, rate] of captainInfo.rates.entries()) {
    if (!key.endsWith(suffix)) continue;
    const stat = stats.get(key);
    if (!stat) continue;
    expected += stat.total_points * (rate.cap_rate + 2 * rate.tc_rate);
  }
  return expected;
};
