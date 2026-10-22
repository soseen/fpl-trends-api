import { STRATUM_A_MAX, STRATUM_B_MAX, type Stratum } from "./rangeStats.js";

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

// GW1 has no pre-range rank, so ranges beginning at GW1 use rank at the end
// of the selected range. This is intentionally descriptive: it answers what
// the managers who finished that range in the Top 100k/10k did. Later ranges
// keep using rank immediately before the range so their cohorts remain causal.
export const comparisonCohortGw = (startGw: number, endGw: number): number =>
  startGw === 1 ? endGw : startGw - 1;

export { readComparison as getComparisonCohorts } from "../analytics/readers.js";
