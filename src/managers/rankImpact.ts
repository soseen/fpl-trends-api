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
  if (stratum === null) {
    const weightedRows = await prisma.$queryRawUnsafe<
      Array<{
        gw: number;
        captain_element: number;
        sample_size: number;
        cap_rate: number;
        tc_rate: number;
      }>
    >(
      `
      WITH sample_sizes AS (
        SELECT gw, stratum, SUM(picks)::numeric AS sample_size
        FROM stratum_captain_picks_gw
        WHERE gw BETWEEN $1 AND $2
        GROUP BY gw, stratum
      ),
      population_grid AS (
        SELECT
          e.id AS gw,
          source.stratum,
          CASE source.stratum
            WHEN 1 THEN LEAST(e.ranked_count, 10000)::numeric
            WHEN 2 THEN GREATEST(LEAST(e.ranked_count, 100000) - 10000, 0)::numeric
            ELSE GREATEST(e.ranked_count - 100000, 0)::numeric
          END AS population
        FROM events e
        CROSS JOIN (VALUES (1), (2), (3)) AS source(stratum)
        WHERE e.id BETWEEN $1 AND $2
      ),
      coverage AS (
        SELECT
          p.gw,
          BOOL_AND(
            p.population = 0 OR COALESCE(s.sample_size, 0) > 0
          ) AS complete
        FROM population_grid p
        LEFT JOIN sample_sizes s
          ON s.gw = p.gw AND s.stratum = p.stratum
        GROUP BY p.gw
      ),
      weights AS (
        SELECT
          p.gw,
          p.stratum,
          s.sample_size,
          p.population,
          p.population / s.sample_size AS sample_weight
        FROM population_grid p
        JOIN sample_sizes s
          ON s.gw = p.gw AND s.stratum = p.stratum
        JOIN coverage c ON c.gw = p.gw AND c.complete
        WHERE p.population > 0
      ),
      effective_samples AS (
        SELECT
          gw,
          GREATEST(
            ROUND(
              POWER(SUM(population), 2)
                / NULLIF(SUM(sample_size * sample_weight * sample_weight), 0)
            )::int,
            1
          ) AS sample_size,
          SUM(population)::numeric AS weighted_population
        FROM weights
        GROUP BY gw
      )
      SELECT
        picks.gw,
        picks.captain_element,
        sample.sample_size,
        (
          COALESCE(
            SUM(picks.picks * weight.sample_weight)
              FILTER (WHERE picks.captain_multiplier = 2),
            0
          ) / sample.weighted_population
        )::double precision AS cap_rate,
        (
          COALESCE(
            SUM(picks.picks * weight.sample_weight)
              FILTER (WHERE picks.captain_multiplier = 3),
            0
          ) / sample.weighted_population
        )::double precision AS tc_rate
      FROM stratum_captain_picks_gw picks
      JOIN weights weight
        ON weight.gw = picks.gw AND weight.stratum = picks.stratum
      JOIN effective_samples sample ON sample.gw = picks.gw
      GROUP BY
        picks.gw,
        picks.captain_element,
        sample.sample_size,
        sample.weighted_population
      `,
      startGw,
      endGw,
    );

    for (const row of weightedRows) {
      perGwSampleSize.set(row.gw, row.sample_size);
      rates.set(playerGwKey(row.captain_element, row.gw), {
        cap_rate: row.cap_rate,
        tc_rate: row.tc_rate,
      });
    }
    return { rates, perGwSampleSize };
  }

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
  const causalBand = `CASE WHEN sampled.gw = 1 THEN 0 ELSE ${rankBandSqlCase(
    "mh_previous.overall_rank",
  )} END`;

  const captainRows = await prisma.$queryRawUnsafe<
    Array<{
      rank_band: number;
      gw: number;
      captain_element: number;
      sample_size: number;
      cap_rate: number;
      tc_rate: number;
    }>
  >(
    `
    WITH same_gw_sampled_rows AS (
      SELECT
        mp.entry_id,
        mp.gw,
        mp.captain_element,
        mp.captain_multiplier,
        mp.sample_stratum
      FROM manager_picks mp
      WHERE mp.gw BETWEEN $1 AND $2
        AND mp.captain_element IS NOT NULL
        AND mp.captain_multiplier IS NOT NULL
        AND mp.sampled_at_gw = mp.gw
        AND mp.sample_stratum BETWEEN 1 AND 3
    ),
    sample_stratum_sizes AS (
      SELECT
        gw,
        sample_stratum,
        COUNT(*)::numeric AS sample_size
      FROM same_gw_sampled_rows
      GROUP BY gw, sample_stratum
    ),
    sample_stratum_population_grid AS (
      SELECT
        e.id AS gw,
        source.sample_stratum,
        CASE source.sample_stratum
          WHEN 1 THEN LEAST(e.ranked_count, 10000)::numeric
          WHEN 2 THEN GREATEST(LEAST(e.ranked_count, 100000) - 10000, 0)::numeric
          ELSE GREATEST(e.ranked_count - 100000, 0)::numeric
        END AS population
      FROM events e
      CROSS JOIN (VALUES (1), (2), (3)) AS source(sample_stratum)
      WHERE e.id BETWEEN $1 AND $2
    ),
    sample_coverage AS (
      SELECT
        p.gw,
        BOOL_AND(
          p.population = 0 OR COALESCE(s.sample_size, 0) > 0
        ) AS complete
      FROM sample_stratum_population_grid p
      LEFT JOIN sample_stratum_sizes s
        ON s.gw = p.gw
       AND s.sample_stratum = p.sample_stratum
      GROUP BY p.gw
    ),
    sample_weights AS (
      SELECT
        p.gw,
        p.sample_stratum,
        p.population / s.sample_size AS sample_weight
      FROM sample_stratum_population_grid p
      JOIN sample_stratum_sizes s
        ON s.gw = p.gw
       AND s.sample_stratum = p.sample_stratum
      JOIN sample_coverage c ON c.gw = p.gw AND c.complete
      WHERE p.population > 0
    ),
    weighted_rows AS (
      SELECT
        (${causalBand})::int AS rank_band,
        sampled.gw,
        sampled.captain_element,
        sampled.captain_multiplier,
        weight.sample_weight
      FROM same_gw_sampled_rows sampled
      LEFT JOIN manager_history mh_previous
        ON mh_previous.entry_id = sampled.entry_id
       AND mh_previous.gw = sampled.gw - 1
      JOIN sample_weights weight
        ON weight.gw = sampled.gw
       AND weight.sample_stratum = sampled.sample_stratum
      WHERE (sampled.gw = 1 OR mh_previous.overall_rank > 0)
        AND (${causalBand}) = ANY($3::int[])
    ),
    weighted_samples AS (
      SELECT
        rank_band,
        gw,
        GREATEST(
          ROUND(
            POWER(SUM(sample_weight), 2)
              / NULLIF(SUM(sample_weight * sample_weight), 0)
          )::int,
          1
        ) AS sample_size,
        SUM(sample_weight)::numeric AS weighted_population
      FROM weighted_rows
      GROUP BY rank_band, gw
    )
    SELECT
      weighted.rank_band,
      weighted.gw,
      weighted.captain_element,
      sample.sample_size,
      (
        COALESCE(
          SUM(weighted.sample_weight)
            FILTER (WHERE weighted.captain_multiplier = 2),
          0
        ) / sample.weighted_population
      )::double precision AS cap_rate,
      (
        COALESCE(
          SUM(weighted.sample_weight)
            FILTER (WHERE weighted.captain_multiplier = 3),
          0
        ) / sample.weighted_population
      )::double precision AS tc_rate
    FROM weighted_rows weighted
    JOIN weighted_samples sample
      ON sample.rank_band = weighted.rank_band
     AND sample.gw = weighted.gw
    GROUP BY
      weighted.rank_band,
      weighted.gw,
      weighted.captain_element,
      sample.sample_size,
      sample.weighted_population
    `,
    startGw,
    endGw,
    bands,
  );

  for (const r of captainRows) {
    if (comparisonBandByGw.get(r.gw) !== r.rank_band) continue;
    perGwSampleSize.set(r.gw, r.sample_size);
    rates.set(playerGwKey(r.captain_element, r.gw), {
      cap_rate: r.cap_rate,
      tc_rate: r.tc_rate,
    });
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
