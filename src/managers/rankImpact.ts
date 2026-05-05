import { prisma } from "../database/client.js";
import type { PlayerHistory } from "../types.js";
import { netPointsForEvent } from "./activityFilter.js";
import { fetchEntryHistory, fetchEntrySummary } from "./fetchManager.js";
import {
  pickStratum,
  rangeDensityFromBuckets,
  stratumCMax,
  type Stratum,
} from "./rangeStats.js";

export const RANK_DENSITY_HALF_WINDOW = 25;
export const SMALL_CAPTAIN_SAMPLE_THRESHOLD = 50;

export type RankImpactContext = {
  user_range_points: number;
  stratum: Stratum | null;
  stratum_avg_range_points: number | null;
  rank_per_point: number | null;
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

export const ownershipPct = (
  stat: PlayerGwRankStat | undefined,
): number => {
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

  const userRangePoints = (resolvedHistory.current ?? [])
    .filter((ev) => ev.event >= startGw && ev.event <= endGw)
    .reduce((acc, ev) => acc + netPointsForEvent(ev), 0);

  const stratum = pickStratum(summary.summary_overall_rank, cMax);
  const density = await rangeDensityFromBuckets(
    stratum,
    startGw,
    endGw,
    userRangePoints,
    RANK_DENSITY_HALF_WINDOW,
  );

  return {
    user_range_points: userRangePoints,
    stratum,
    stratum_avg_range_points: density.stratumAverage,
    rank_per_point: density.rankPerPoint,
  };
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
  if (stratum === null) return { rates, perGwSampleSize };

  const sampleRows = await prisma.$queryRawUnsafe<
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

  const captainRows = await prisma.$queryRawUnsafe<
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
