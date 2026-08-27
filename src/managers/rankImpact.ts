import { prisma } from "../database/client.js";
import type { PlayerHistory } from "../types.js";
import { netPointsForEvent } from "./activityFilter.js";
import { fetchEntryHistory, fetchEntrySummary } from "./fetchManager.js";
import {
  overallRankMovementEstimator,
  pickStratum,
  rangeDensityFromCumulative,
  stratumCMax,
  type Stratum,
} from "./rangeStats.js";
import { pickRankBand, rankBandSqlCase, type RankBand } from "./rankBands.js";
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
    history ? Promise.resolve(history) : fetchEntryHistory(entryId),
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
      COALESCE(MAX(e.ranked_count), 0)::int AS ranked_count
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
  stratum: Stratum | null,
  startGw: number,
  endGw: number,
): Promise<CaptainRateInfo> => {
  const rates = new Map<string, CaptainRate>();
  const perGwSampleSize = new Map<number, number>();
  const sampleRows =
    stratum === null
      ? await prisma.$queryRawUnsafe<
          Array<{ gw: number; sample_size: number }>
        >(
          `
          SELECT gw, SUM(picks)::int AS sample_size
          FROM stratum_captain_picks_gw
          WHERE gw BETWEEN $1 AND $2
          GROUP BY gw
          `,
          startGw,
          endGw,
        )
      : await prisma.$queryRawUnsafe<
          Array<{ gw: number; sample_size: number }>
        >(
          `
          SELECT gw, SUM(picks)::int AS sample_size
          FROM stratum_captain_picks_gw
          WHERE gw BETWEEN $1 AND $2
            AND stratum = $3
          GROUP BY gw
          `,
          startGw,
          endGw,
          stratum,
        );
  for (const r of sampleRows) perGwSampleSize.set(r.gw, r.sample_size);

  const captainRows =
    stratum === null
      ? await prisma.$queryRawUnsafe<
          Array<{
            gw: number;
            captain_element: number;
            captain_multiplier: number;
            picks: number;
          }>
        >(
          `
          SELECT
            gw,
            captain_element,
            captain_multiplier,
            SUM(picks)::int AS picks
          FROM stratum_captain_picks_gw
          WHERE gw BETWEEN $1 AND $2
          GROUP BY gw, captain_element, captain_multiplier
          `,
          startGw,
          endGw,
        )
      : await prisma.$queryRawUnsafe<
          Array<{
            gw: number;
            captain_element: number;
            captain_multiplier: number;
            picks: number;
          }>
        >(
          `
          SELECT gw, captain_element, captain_multiplier, picks
          FROM stratum_captain_picks_gw
          WHERE gw BETWEEN $1 AND $2
            AND stratum = $3
          `,
          startGw,
          endGw,
          stratum,
        );

  for (const r of captainRows) {
    const sample = perGwSampleSize.get(r.gw) ?? 0;
    if (sample === 0) continue;

    const key = playerGwKey(r.captain_element, r.gw);
    const existing = rates.get(key) ?? { cap_rate: 0, tc_rate: 0 };
    if (r.captain_multiplier === 3) {
      existing.tc_rate += r.picks / sample;
    } else if (r.captain_multiplier === 2) {
      existing.cap_rate += r.picks / sample;
    }
    rates.set(key, existing);
  }

  return { rates, perGwSampleSize };
};

export const fetchCaptainRatesInRankBand = async (
  comparisonBandByGw: ReadonlyMap<number, RankBand | 0 | null>,
  startGw: number,
  endGw: number,
): Promise<CaptainRateInfo> => {
  const rates = new Map<string, CaptainRate>();
  const perGwSampleSize = new Map<number, number>();
  const bands = Array.from(
    new Set(
      Array.from(comparisonBandByGw.values()).filter(
        (band): band is RankBand | 0 => band !== null,
      ),
    ),
  );
  if (bands.length === 0) return { rates, perGwSampleSize };
  const causalBand = `CASE WHEN mp.gw = 1 THEN 0 ELSE ${rankBandSqlCase(
    "mh_previous.overall_rank",
  )} END`;

  const sampleRows = await prisma.$queryRawUnsafe<
    Array<{ rank_band: number; gw: number; sample_size: number }>
  >(
    `
    SELECT (${causalBand})::int AS rank_band, mp.gw, COUNT(*)::int AS sample_size
    FROM manager_picks mp
    LEFT JOIN manager_history mh_previous
      ON mh_previous.entry_id = mp.entry_id
     AND mh_previous.gw = mp.gw - 1
    WHERE mp.gw BETWEEN $1 AND $2
      AND mp.captain_element IS NOT NULL
      AND mp.captain_multiplier IS NOT NULL
      AND (${causalBand}) = ANY($3::int[])
    GROUP BY rank_band, mp.gw
    `,
    startGw,
    endGw,
    bands,
  );
  for (const r of sampleRows) {
    if (comparisonBandByGw.get(r.gw) !== r.rank_band) continue;
    perGwSampleSize.set(r.gw, r.sample_size);
  }

  const captainRows = await prisma.$queryRawUnsafe<
    Array<{
      rank_band: number;
      gw: number;
      captain_element: number;
      captain_multiplier: number;
      picks: number;
    }>
  >(
    `
    SELECT
      (${causalBand})::int AS rank_band,
      mp.gw,
      mp.captain_element,
      mp.captain_multiplier,
      COUNT(*)::int AS picks
    FROM manager_picks mp
    LEFT JOIN manager_history mh_previous
      ON mh_previous.entry_id = mp.entry_id
     AND mh_previous.gw = mp.gw - 1
    WHERE mp.gw BETWEEN $1 AND $2
      AND mp.captain_element IS NOT NULL
      AND mp.captain_multiplier IS NOT NULL
      AND (${causalBand}) = ANY($3::int[])
    GROUP BY rank_band, mp.gw, mp.captain_element, mp.captain_multiplier
    `,
    startGw,
    endGw,
    bands,
  );

  for (const r of captainRows) {
    if (comparisonBandByGw.get(r.gw) !== r.rank_band) continue;
    const sample = perGwSampleSize.get(r.gw) ?? 0;
    if (sample === 0) continue;

    const key = playerGwKey(r.captain_element, r.gw);
    const existing = rates.get(key) ?? { cap_rate: 0, tc_rate: 0 };
    if (r.captain_multiplier === 3) {
      existing.tc_rate += r.picks / sample;
    } else if (r.captain_multiplier === 2) {
      existing.cap_rate += r.picks / sample;
    }
    rates.set(key, existing);
  }

  return { rates, perGwSampleSize };
};

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
