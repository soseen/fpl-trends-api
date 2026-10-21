import { prisma } from "../database/client.js";
import { rankedPopulationSql } from "./rankedPopulation.js";
import {
  STRATUM_A_MAX,
  STRATUM_B_MAX,
  trueStratumSizes,
  type Stratum,
} from "./rangeStats.js";

export type CohortAggregate = {
  avg_total_points: number | null;
  avg_transfers: number | null;
  avg_hits: number | null;
  avg_bench: number | null;
  avg_captain_bonus: number | null;
  avg_gw_score: number | null;
  wildcards_h1_rate: number | null;
  wildcards_h2_rate: number | null;
  free_hits_h1_rate: number | null;
  free_hits_h2_rate: number | null;
  bench_boosts_h1_rate: number | null;
  bench_boosts_h2_rate: number | null;
  triple_captains_h1_rate: number | null;
  triple_captains_h2_rate: number | null;
  sample_size: number;
  with_hits_data: number;
  with_bench_data: number;
  with_transfers_data: number;
  with_captain_data: number;
  with_chips_data: number;
};

export type CaptainChoice = {
  player_id: number | null;
  sample_complete: boolean;
};

export type ComparisonCohorts = {
  average: CohortAggregate;
  top100k: CohortAggregate;
  top10k: CohortAggregate;
  averageCaptain: CaptainChoice;
  top100kCaptain: CaptainChoice;
  top10kCaptain: CaptainChoice;
};

type CohortRow = {
  stratum: number;
  sample_size: bigint | number | null;
  sum_points: bigint | number | null;
  sum_gws: bigint | number | null;
  complete_transfers: bigint | number | null;
  sum_transfers_complete: bigint | number | null;
  complete_hits: bigint | number | null;
  sum_hits_cost_complete: bigint | number | null;
  complete_bench: bigint | number | null;
  sum_bench_complete: bigint | number | null;
  complete_captain: bigint | number | null;
  sum_captain_complete: bigint | number | null;
  complete_chips: bigint | number | null;
  wildcards_h1: bigint | number | null;
  wildcards_h2: bigint | number | null;
  freehits_h1: bigint | number | null;
  freehits_h2: bigint | number | null;
  bboosts_h1: bigint | number | null;
  bboosts_h2: bigint | number | null;
  triplecaptains_h1: bigint | number | null;
  triplecaptains_h2: bigint | number | null;
};

type CaptainRow = {
  stratum: number;
  gw: number;
  captain_element: number;
  picks: bigint | number;
  gw_sample: bigint | number;
};

export type CaptainBonusRow = {
  stratum: number;
  gw: number;
  avg_bonus: number | null;
  sample_size: number;
  ranked_population: number;
};

export type CaptainBonusAverages = {
  average: number | null;
  top100k: number | null;
  top10k: number | null;
};

type NumericCohortRow = {
  stratum: Stratum;
  sampleSize: number;
  sumPoints: number;
  sumGws: number;
  completeTransfers: number;
  sumTransfers: number;
  completeHits: number;
  sumHitsCost: number;
  completeBench: number;
  sumBench: number;
  completeCaptain: number;
  sumCaptain: number;
  completeChips: number;
  wildcardsH1: number;
  wildcardsH2: number;
  freehitsH1: number;
  freehitsH2: number;
  bboostsH1: number;
  bboostsH2: number;
  tripleCaptainsH1: number;
  tripleCaptainsH2: number;
};

const COVERAGE_THRESHOLD = 0.5;
const ALL_STRATA: readonly Stratum[] = [1, 2, 3];
const CAPTAIN_STRATUM_SAMPLE_MINIMUM: Record<Stratum, number> = {
  1: 250,
  2: 750,
  3: 500,
};

const numberValue = (value: bigint | number | null | undefined): number =>
  typeof value === "bigint" ? Number(value) : (value ?? 0);

const stratumPopulation = (
  stratum: Stratum,
  rankedPopulation: number,
): number => {
  if (stratum === 1) return Math.min(rankedPopulation, STRATUM_A_MAX);
  if (stratum === 2) {
    return Math.max(
      Math.min(rankedPopulation, STRATUM_B_MAX) - STRATUM_A_MAX,
      0,
    );
  }
  return Math.max(rankedPopulation - STRATUM_B_MAX, 0);
};

// Captain picks are sampled independently in every GW, so requiring the same
// manager to have picks for the whole selected range makes coverage collapse
// as managers move between rank bands. Build the range value as the sum of
// per-GW averages instead. Population weighting prevents the deliberately
// oversized Top 100k samples from biasing the overall-manager comparison.
export const combineCaptainBonusRows = (
  rows: ReadonlyArray<CaptainBonusRow>,
  startGw: number,
  endGw: number,
): CaptainBonusAverages => {
  const rowsByGw = new Map<number, Map<Stratum, CaptainBonusRow>>();
  for (const row of rows) {
    if (!ALL_STRATA.includes(row.stratum as Stratum)) continue;
    const stratum = row.stratum as Stratum;
    const gwRows = rowsByGw.get(row.gw) ?? new Map();
    gwRows.set(stratum, row);
    rowsByGw.set(row.gw, gwRows);
  }

  const combine = (strata: readonly Stratum[]): number | null => {
    let rangeTotal = 0;
    for (let gw = startGw; gw <= endGw; gw += 1) {
      const gwRows = rowsByGw.get(gw);
      const rankedPopulation = Math.max(
        0,
        ...strata.map(
          (stratum) => gwRows?.get(stratum)?.ranked_population ?? 0,
        ),
      );
      if (!gwRows || rankedPopulation <= 0) return null;

      let weightedBonus = 0;
      let population = 0;
      for (const stratum of strata) {
        const weight = stratumPopulation(stratum, rankedPopulation);
        if (weight <= 0) continue;
        const row = gwRows.get(stratum);
        if (
          !row ||
          row.avg_bonus === null ||
          row.sample_size < CAPTAIN_STRATUM_SAMPLE_MINIMUM[stratum]
        ) {
          return null;
        }
        weightedBonus += row.avg_bonus * weight;
        population += weight;
      }
      if (population <= 0) return null;
      rangeTotal += weightedBonus / population;
    }
    return rangeTotal;
  };

  return {
    average: combine([1, 2, 3]),
    top100k: combine([1, 2]),
    top10k: combine([1]),
  };
};

const emptyAggregate = (): CohortAggregate => ({
  avg_total_points: null,
  avg_transfers: null,
  avg_hits: null,
  avg_bench: null,
  avg_captain_bonus: null,
  avg_gw_score: null,
  wildcards_h1_rate: null,
  wildcards_h2_rate: null,
  free_hits_h1_rate: null,
  free_hits_h2_rate: null,
  bench_boosts_h1_rate: null,
  bench_boosts_h2_rate: null,
  triple_captains_h1_rate: null,
  triple_captains_h2_rate: null,
  sample_size: 0,
  with_hits_data: 0,
  with_bench_data: 0,
  with_transfers_data: 0,
  with_captain_data: 0,
  with_chips_data: 0,
});

const toNumericRow = (row: CohortRow): NumericCohortRow | null => {
  if (!ALL_STRATA.includes(row.stratum as Stratum)) return null;
  return {
    stratum: row.stratum as Stratum,
    sampleSize: numberValue(row.sample_size),
    sumPoints: numberValue(row.sum_points),
    sumGws: numberValue(row.sum_gws),
    completeTransfers: numberValue(row.complete_transfers),
    sumTransfers: numberValue(row.sum_transfers_complete),
    completeHits: numberValue(row.complete_hits),
    sumHitsCost: numberValue(row.sum_hits_cost_complete),
    completeBench: numberValue(row.complete_bench),
    sumBench: numberValue(row.sum_bench_complete),
    completeCaptain: numberValue(row.complete_captain),
    sumCaptain: numberValue(row.sum_captain_complete),
    completeChips: numberValue(row.complete_chips),
    wildcardsH1: numberValue(row.wildcards_h1),
    wildcardsH2: numberValue(row.wildcards_h2),
    freehitsH1: numberValue(row.freehits_h1),
    freehitsH2: numberValue(row.freehits_h2),
    bboostsH1: numberValue(row.bboosts_h1),
    bboostsH2: numberValue(row.bboosts_h2),
    tripleCaptainsH1: numberValue(row.triplecaptains_h1),
    tripleCaptainsH2: numberValue(row.triplecaptains_h2),
  };
};

const weightedMean = (
  rows: ReadonlyArray<NumericCohortRow>,
  weights: Record<Stratum, number>,
  value: (row: NumericCohortRow) => number | null,
): number | null => {
  let total = 0;
  let totalWeight = 0;
  for (const row of rows) {
    const weight = weights[row.stratum];
    const rowValue = value(row);
    if (weight <= 0 || rowValue === null) continue;
    total += rowValue * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? total / totalWeight : null;
};

const coveredMean = (
  rows: ReadonlyArray<NumericCohortRow>,
  weights: Record<Stratum, number>,
  complete: (row: NumericCohortRow) => number,
  sum: (row: NumericCohortRow) => number,
): number | null => {
  const coverage = weightedMean(rows, weights, (row) =>
    row.sampleSize > 0 ? complete(row) / row.sampleSize : null,
  );
  if (coverage === null || coverage < COVERAGE_THRESHOLD) return null;
  return weightedMean(rows, weights, (row) => {
    const denominator = complete(row);
    return denominator > 0 ? sum(row) / denominator : null;
  });
};

export const combineCohortRows = (
  rows: ReadonlyArray<NumericCohortRow>,
  weights: Record<Stratum, number>,
): CohortAggregate => {
  if (rows.length === 0) return emptyAggregate();
  const sampleSize = rows.reduce((total, row) => total + row.sampleSize, 0);
  const sumComplete = (read: (row: NumericCohortRow) => number): number =>
    rows.reduce((total, row) => total + read(row), 0);
  const chipRate = (read: (row: NumericCohortRow) => number): number | null =>
    coveredMean(rows, weights, (row) => row.completeChips, read);

  return {
    avg_total_points: weightedMean(rows, weights, (row) =>
      row.sampleSize > 0 ? row.sumPoints / row.sampleSize : null,
    ),
    avg_transfers: coveredMean(
      rows,
      weights,
      (row) => row.completeTransfers,
      (row) => row.sumTransfers,
    ),
    avg_hits: coveredMean(
      rows,
      weights,
      (row) => row.completeHits,
      (row) => row.sumHitsCost / 4,
    ),
    avg_bench: coveredMean(
      rows,
      weights,
      (row) => row.completeBench,
      (row) => row.sumBench,
    ),
    avg_captain_bonus: coveredMean(
      rows,
      weights,
      (row) => row.completeCaptain,
      (row) => row.sumCaptain,
    ),
    avg_gw_score: weightedMean(rows, weights, (row) =>
      row.sumGws > 0 ? row.sumPoints / row.sumGws : null,
    ),
    wildcards_h1_rate: chipRate((row) => row.wildcardsH1),
    wildcards_h2_rate: chipRate((row) => row.wildcardsH2),
    free_hits_h1_rate: chipRate((row) => row.freehitsH1),
    free_hits_h2_rate: chipRate((row) => row.freehitsH2),
    bench_boosts_h1_rate: chipRate((row) => row.bboostsH1),
    bench_boosts_h2_rate: chipRate((row) => row.bboostsH2),
    triple_captains_h1_rate: chipRate((row) => row.tripleCaptainsH1),
    triple_captains_h2_rate: chipRate((row) => row.tripleCaptainsH2),
    sample_size: sampleSize,
    with_hits_data: sumComplete((row) => row.completeHits),
    with_bench_data: sumComplete((row) => row.completeBench),
    with_transfers_data: sumComplete((row) => row.completeTransfers),
    with_captain_data: sumComplete((row) => row.completeCaptain),
    with_chips_data: sumComplete((row) => row.completeChips),
  };
};

export const combineComparisonCohortRows = (
  rows: ReadonlyArray<NumericCohortRow>,
  weights: Record<Stratum, number>,
): Pick<ComparisonCohorts, "average" | "top100k" | "top10k"> => {
  const byStrata = (strata: readonly Stratum[]): NumericCohortRow[] =>
    rows.filter((row) => strata.includes(row.stratum));

  return {
    average: combineCohortRows(byStrata([1, 2, 3]), weights),
    top100k: combineCohortRows(byStrata([1, 2]), weights),
    top10k: combineCohortRows(byStrata([1]), weights),
  };
};

const captainChoice = (
  rows: ReadonlyArray<CaptainRow>,
  strata: ReadonlySet<Stratum>,
  weights: Record<Stratum, number>,
  expectedGws: number,
): CaptainChoice => {
  const relevant = rows.filter((row) => strata.has(row.stratum as Stratum));
  const gws = new Set(relevant.map((row) => row.gw));
  if (gws.size < expectedGws)
    return { player_id: null, sample_complete: false };

  const scoreByPlayer = new Map<number, number>();
  for (const row of relevant) {
    const stratum = row.stratum as Stratum;
    const sample = numberValue(row.gw_sample);
    if (sample <= 0 || weights[stratum] <= 0) continue;
    const weightedRate = (numberValue(row.picks) / sample) * weights[stratum];
    scoreByPlayer.set(
      row.captain_element,
      (scoreByPlayer.get(row.captain_element) ?? 0) + weightedRate,
    );
  }

  let playerId: number | null = null;
  let highestScore = -1;
  for (const [candidate, score] of scoreByPlayer) {
    if (score > highestScore) {
      playerId = candidate;
      highestScore = score;
    }
  }
  return { player_id: playerId, sample_complete: playerId !== null };
};

// GW1 has no pre-range rank, so ranges beginning at GW1 use rank at the end
// of the selected range. This is intentionally descriptive: it answers what
// the managers who finished that range in the Top 100k/10k did. Later ranges
// keep using rank immediately before the range so their cohorts remain causal.
export const comparisonCohortGw = (startGw: number, endGw: number): number =>
  startGw === 1 ? endGw : startGw - 1;

const loadComparisonCohorts = async (
  startGw: number,
  endGw: number,
): Promise<ComparisonCohorts> => {
  const expectedGws = endGw - startGw + 1;
  const cohortGw = comparisonCohortGw(startGw, endGw);
  const cohortRank = `COALESCE(
    CASE WHEN NOT cohort_event.data_checked AND ms.last_checked_gw = $3
      THEN ms.overall_rank END, cohort_rank.overall_rank
  )`;
  // Numeric cohort stats come from the range read model maintained by the
  // manager-ingest job. The captain-choice query stays live: it touches only
  // the much smaller manager_picks slice and was not the latency bottleneck.
  const [rawRows, choiceRows, bonusRows, weights] = await Promise.all([
    prisma.$queryRawUnsafe<CohortRow[]>(
      `
      SELECT
        stratum,
        sample_size,
        sum_points,
        sum_gws,
        complete_transfers,
        sum_transfers_complete,
        complete_hits,
        sum_hits_cost_complete,
        complete_bench,
        sum_bench_complete,
        complete_captain,
        sum_captain_complete,
        complete_chips,
        wildcards_h1,
        wildcards_h2,
        freehits_h1,
        freehits_h2,
        bboosts_h1,
        bboosts_h2,
        triplecaptains_h1,
        triplecaptains_h2
      FROM comparison_range_stats
      WHERE start_gw = $1 AND end_gw = $2
      ORDER BY stratum

      `,
      startGw,
      endGw,
    ),
    prisma.$queryRawUnsafe<CaptainRow[]>(
      `
      WITH cohort AS (
        SELECT
          ms.entry_id,
          CASE
            WHEN ${cohortRank} BETWEEN 1 AND 10000 THEN 1
            WHEN ${cohortRank} BETWEEN 10001 AND 100000 THEN 2
            WHEN ${cohortRank} > 100000 THEN 3
            ELSE NULL
          END::int AS stratum
        FROM manager_summary ms
        JOIN manager_history cohort_rank
          ON cohort_rank.entry_id = ms.entry_id AND cohort_rank.gw = $3
        JOIN events cohort_event ON cohort_event.id = $3
        WHERE ${cohortRank} > 0
      ), grouped AS (
        SELECT
          c.stratum,
          mp.gw,
          mp.captain_element,
          COUNT(*)::bigint AS picks
        FROM manager_picks mp
        JOIN cohort c ON c.entry_id = mp.entry_id
        WHERE mp.gw BETWEEN $1 AND $2
          AND mp.captain_element IS NOT NULL
          AND c.stratum IS NOT NULL
        GROUP BY c.stratum, mp.gw, mp.captain_element
      )
      SELECT
        stratum,
        gw,
        captain_element,
        picks,
        SUM(picks) OVER (PARTITION BY stratum, gw)::bigint AS gw_sample
      FROM grouped
      `,
      startGw,
      endGw,
      cohortGw,
    ),
    prisma.$queryRawUnsafe<CaptainBonusRow[]>(
      `
      WITH player_points AS (
        SELECT footballer_id, round, SUM(total_points)::int AS total_points
        FROM history
        WHERE round BETWEEN $1 AND $2
        GROUP BY footballer_id, round
      ), per_gw_stratum AS (
        SELECT
          sc.stratum,
          sc.gw,
          (
            SUM(
              sc.picks
                * COALESCE(pp.total_points, 0)
                * GREATEST(sc.captain_multiplier - 1, 0)
            )::float / NULLIF(SUM(sc.picks), 0)
          )::float AS avg_bonus,
          SUM(sc.picks)::int AS sample_size
        FROM stratum_captain_picks_gw sc
        LEFT JOIN player_points pp
          ON pp.footballer_id = sc.captain_element AND pp.round = sc.gw
        WHERE sc.gw BETWEEN $1 AND $2
        GROUP BY sc.stratum, sc.gw
      )
      SELECT
        captain.stratum,
        captain.gw,
        captain.avg_bonus,
        captain.sample_size,
        ${rankedPopulationSql("e")}::int AS ranked_population
      FROM per_gw_stratum captain
      JOIN events e ON e.id = captain.gw
      `,
      startGw,
      endGw,
    ),
    trueStratumSizes(cohortGw),
  ]);

  if (rawRows.length === 0) {
    throw new Error(
      `comparison_range_stats missing for ${startGw}..${endGw}; ` +
        "run backfill-comparison-ranges",
    );
  }

  const rows = rawRows
    .map(toNumericRow)
    .filter((row): row is NumericCohortRow => row !== null);
  const aggregates = combineComparisonCohortRows(rows, weights);
  const captainBonuses = combineCaptainBonusRows(bonusRows, startGw, endGw);

  return {
    average: {
      ...aggregates.average,
      avg_captain_bonus: captainBonuses.average,
    },
    top100k: {
      ...aggregates.top100k,
      avg_captain_bonus: captainBonuses.top100k,
    },
    top10k: {
      ...aggregates.top10k,
      avg_captain_bonus: captainBonuses.top10k,
    },
    averageCaptain: captainChoice(
      choiceRows,
      new Set([1, 2, 3]),
      weights,
      expectedGws,
    ),
    top100kCaptain: captainChoice(
      choiceRows,
      new Set([1, 2]),
      weights,
      expectedGws,
    ),
    top10kCaptain: captainChoice(
      choiceRows,
      new Set([1]),
      weights,
      expectedGws,
    ),
  };
};

const CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_CACHE_ENTRIES = 64;
const cohortCache = new Map<
  string,
  { expiresAt: number; value: Promise<ComparisonCohorts> }
>();

export const getComparisonCohorts = (
  startGw: number,
  endGw: number,
): Promise<ComparisonCohorts> => {
  const key = `${startGw}:${endGw}`;
  const now = Date.now();
  const cached = cohortCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  if (cached) cohortCache.delete(key);

  if (cohortCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cohortCache.keys().next().value;
    if (oldestKey !== undefined) cohortCache.delete(oldestKey);
  }

  const value = loadComparisonCohorts(startGw, endGw).catch((error) => {
    cohortCache.delete(key);
    throw error;
  });
  cohortCache.set(key, { expiresAt: now + CACHE_TTL_MS, value });
  return value;
};
