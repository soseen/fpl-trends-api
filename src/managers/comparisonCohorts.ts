import { prisma } from "../database/client.js";
import { trueStratumSizes, type Stratum } from "./rangeStats.js";

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

export type CausalComparisonCohorts = {
  average: CohortAggregate;
  top100k: CohortAggregate;
  top10k: CohortAggregate;
  averageCaptain: CaptainChoice;
  top100kCaptain: CaptainChoice;
  top10kCaptain: CaptainChoice;
  eliteAvailable: boolean;
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
};

type CaptainRow = {
  stratum: number;
  gw: number;
  captain_element: number;
  picks: bigint | number;
  gw_sample: bigint | number;
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
};

const COVERAGE_THRESHOLD = 0.5;
const ALL_STRATA: readonly Stratum[] = [1, 2, 3];

const numberValue = (value: bigint | number | null | undefined): number =>
  typeof value === "bigint" ? Number(value) : (value ?? 0);

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
    sample_size: sampleSize,
    with_hits_data: sumComplete((row) => row.completeHits),
    with_bench_data: sumComplete((row) => row.completeBench),
    with_transfers_data: sumComplete((row) => row.completeTransfers),
    with_captain_data: sumComplete((row) => row.completeCaptain),
    with_chips_data: sumComplete((row) => row.completeChips),
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

const loadCausalComparisonCohorts = async (
  startGw: number,
  endGw: number,
): Promise<CausalComparisonCohorts> => {
  const expectedGws = endGw - startGw + 1;
  const cohortGw = startGw === 1 ? endGw : startGw - 1;
  const [rawRows, captainRows, trueSizes] = await Promise.all([
    prisma.$queryRawUnsafe<CohortRow[]>(
      `
      WITH cohort AS (
        SELECT
          c_end.entry_id,
          CASE
            WHEN cohort_rank.overall_rank BETWEEN 1 AND 10000 THEN 1
            WHEN cohort_rank.overall_rank BETWEEN 10001 AND 100000 THEN 2
            WHEN cohort_rank.overall_rank > 100000 THEN 3
            ELSE NULL
          END::int AS stratum,
          c_end.cumulative_captain_bonus
            - COALESCE(c_start.cumulative_captain_bonus, 0) AS captain_bonus,
          c_end.picks_count_cum - COALESCE(c_start.picks_count_cum, 0) AS pick_gws,
          ms.has_chip_history
        FROM manager_cumulative c_end
        JOIN manager_summary ms ON ms.entry_id = c_end.entry_id
        LEFT JOIN manager_cumulative c_start
          ON c_start.entry_id = c_end.entry_id AND c_start.gw = $1 - 1
        JOIN manager_history cohort_rank
          ON cohort_rank.entry_id = c_end.entry_id AND cohort_rank.gw = $3
        WHERE c_end.gw = $2
          AND cohort_rank.overall_rank > 0
      ), range_history AS (
        SELECT
          mh.entry_id,
          COUNT(*)::int AS played_gws,
          SUM(mh.points)::bigint AS points,
          COUNT(mh.event_transfers)::int AS transfer_gws,
          COALESCE(SUM(mh.event_transfers), 0)::bigint AS transfers,
          COUNT(mh.event_transfers_cost)::int AS hits_gws,
          COALESCE(SUM(mh.event_transfers_cost), 0)::bigint AS hits_cost,
          COUNT(mh.points_on_bench)::int AS bench_gws,
          COALESCE(SUM(mh.points_on_bench), 0)::bigint AS bench,
          COUNT(*) FILTER (
            WHERE mh.active_chip = 'wildcard' AND mh.gw <= 19
          )::int AS wildcard_h1,
          COUNT(*) FILTER (
            WHERE mh.active_chip = 'wildcard' AND mh.gw > 19
          )::int AS wildcard_h2,
          COUNT(*) FILTER (
            WHERE mh.active_chip = 'freehit' AND mh.gw <= 19
          )::int AS freehit_h1,
          COUNT(*) FILTER (
            WHERE mh.active_chip = 'freehit' AND mh.gw > 19
          )::int AS freehit_h2,
          COUNT(*) FILTER (
            WHERE mh.active_chip = 'bboost' AND mh.gw <= 19
          )::int AS bboost_h1,
          COUNT(*) FILTER (
            WHERE mh.active_chip = 'bboost' AND mh.gw > 19
          )::int AS bboost_h2
        FROM manager_history mh
        JOIN cohort c ON c.entry_id = mh.entry_id
        WHERE mh.gw BETWEEN $1 AND $2
        GROUP BY mh.entry_id
      )
      SELECT
        c.stratum,
        COUNT(*)::bigint AS sample_size,
        SUM(r.points)::bigint AS sum_points,
        SUM(r.played_gws)::bigint AS sum_gws,
        COUNT(*) FILTER (WHERE r.transfer_gws = $4)::bigint AS complete_transfers,
        SUM(r.transfers) FILTER (WHERE r.transfer_gws = $4)::bigint
          AS sum_transfers_complete,
        COUNT(*) FILTER (WHERE r.hits_gws = $4)::bigint AS complete_hits,
        SUM(r.hits_cost) FILTER (WHERE r.hits_gws = $4)::bigint
          AS sum_hits_cost_complete,
        COUNT(*) FILTER (WHERE r.bench_gws = $4)::bigint AS complete_bench,
        SUM(r.bench) FILTER (WHERE r.bench_gws = $4)::bigint
          AS sum_bench_complete,
        COUNT(*) FILTER (WHERE c.pick_gws = $4)::bigint AS complete_captain,
        SUM(c.captain_bonus) FILTER (WHERE c.pick_gws = $4)::bigint
          AS sum_captain_complete,
        COUNT(*) FILTER (WHERE c.has_chip_history)::bigint AS complete_chips,
        SUM(r.wildcard_h1) FILTER (WHERE c.has_chip_history)::bigint AS wildcards_h1,
        SUM(r.wildcard_h2) FILTER (WHERE c.has_chip_history)::bigint AS wildcards_h2,
        SUM(r.freehit_h1) FILTER (WHERE c.has_chip_history)::bigint AS freehits_h1,
        SUM(r.freehit_h2) FILTER (WHERE c.has_chip_history)::bigint AS freehits_h2,
        SUM(r.bboost_h1) FILTER (WHERE c.has_chip_history)::bigint AS bboosts_h1,
        SUM(r.bboost_h2) FILTER (WHERE c.has_chip_history)::bigint AS bboosts_h2
      FROM cohort c
      JOIN range_history r ON r.entry_id = c.entry_id
      WHERE c.stratum IS NOT NULL
      GROUP BY c.stratum
      `,
      startGw,
      endGw,
      cohortGw,
      expectedGws,
    ),
    prisma.$queryRawUnsafe<CaptainRow[]>(
      `
      WITH cohort AS (
        SELECT
          ms.entry_id,
          CASE
            WHEN mh.overall_rank BETWEEN 1 AND 10000 THEN 1
            WHEN mh.overall_rank BETWEEN 10001 AND 100000 THEN 2
            WHEN mh.overall_rank > 100000 THEN 3
            ELSE NULL
          END::int AS stratum
        FROM manager_summary ms
        JOIN manager_history mh
          ON mh.entry_id = ms.entry_id AND mh.gw = $3
        WHERE mh.overall_rank > 0
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
    trueStratumSizes(cohortGw),
  ]);

  const rows = rawRows
    .map(toNumericRow)
    .filter((row): row is NumericCohortRow => row !== null);
  const byStrata = (strata: readonly Stratum[]): NumericCohortRow[] =>
    rows.filter((row) => strata.includes(row.stratum));
  const all = byStrata([1, 2, 3]);
  const top100 = byStrata([1, 2]);
  const top10 = byStrata([1]);
  const eliteAvailable = startGw > 1;

  return {
    average: combineCohortRows(all, trueSizes),
    top100k: eliteAvailable
      ? combineCohortRows(top100, trueSizes)
      : emptyAggregate(),
    top10k: eliteAvailable
      ? combineCohortRows(top10, trueSizes)
      : emptyAggregate(),
    averageCaptain: captainChoice(
      captainRows,
      new Set([1, 2, 3]),
      trueSizes,
      expectedGws,
    ),
    top100kCaptain: eliteAvailable
      ? captainChoice(captainRows, new Set([1, 2]), trueSizes, expectedGws)
      : { player_id: null, sample_complete: false },
    top10kCaptain: eliteAvailable
      ? captainChoice(captainRows, new Set([1]), trueSizes, expectedGws)
      : { player_id: null, sample_complete: false },
    eliteAvailable,
  };
};

const CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_CACHE_ENTRIES = 64;
const cohortCache = new Map<
  string,
  { expiresAt: number; value: Promise<CausalComparisonCohorts> }
>();

export const getCausalComparisonCohorts = (
  startGw: number,
  endGw: number,
): Promise<CausalComparisonCohorts> => {
  const key = `${startGw}:${endGw}`;
  const now = Date.now();
  const cached = cohortCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  if (cached) cohortCache.delete(key);

  if (cohortCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cohortCache.keys().next().value;
    if (oldestKey !== undefined) cohortCache.delete(oldestKey);
  }

  const value = loadCausalComparisonCohorts(startGw, endGw).catch((error) => {
    cohortCache.delete(key);
    throw error;
  });
  cohortCache.set(key, { expiresAt: now + CACHE_TTL_MS, value });
  return value;
};
