import { pickRankBand } from "../managers/rankBands.js";
import {
  benchmarkSchema,
  CALCULATION_VERSION,
  populationSizes,
  pointKey,
  strata,
  validSquad,
  type Benchmark,
  type Cohort,
  type Exposure,
  type ManagerFact,
  type PlayerPoints,
  type SampleManager,
} from "./model.js";

type Weighted = {
  manager: SampleManager;
  weight: number;
  facts: (ManagerFact | undefined)[];
};
const sum = <T>(items: readonly T[], read: (item: T) => number): number =>
  items.reduce((s, item) => s + read(item), 0);
export const effectiveSampleSize = (
  rows: readonly { weight: number }[],
): number => {
  const weights = sum(rows, (r) => r.weight);
  return weights > 0
    ? (weights * weights) / sum(rows, (r) => r.weight * r.weight)
    : 0;
};
const mean = (
  rows: readonly Weighted[],
  read: (m: SampleManager) => number | null,
  coverage = 0.5,
): number | null => {
  let numerator = 0,
    denominator = 0,
    population = 0;
  for (const row of rows) {
    population += row.weight;
    const value = read(row.manager);
    if (value !== null) {
      denominator += row.weight;
      numerator += row.weight * value;
    }
  }
  return denominator > 0 && denominator >= population * coverage
    ? numerator / denominator
    : null;
};
const aggregate = (
  rows: readonly Weighted[],
  start: number,
  end: number,
  minimum: number,
): Cohort => {
  const factsByManager = new Map(
    rows.map((r) => [
      r.manager,
      r.manager.facts.filter((f) => f.gw >= start && f.gw <= end),
    ]),
  );
  const rangeFacts = (m: SampleManager) => factsByManager.get(m) ?? [];
  const sufficient = effectiveSampleSize(rows) >= minimum;
  const totals = new Map<
    SampleManager,
    Record<"points" | "transfers" | "hits" | "bench", number | null>
  >();
  for (const { manager } of rows) {
    const facts = rangeFacts(manager),
      first = Math.min(...manager.facts.map((f) => f.gw));
    const complete =
      facts.length > 0 && facts.length === end - Math.max(start, first) + 1;
    const values = {
      points: complete ? 0 : null,
      transfers: complete ? 0 : null,
      hits: complete ? 0 : null,
      bench: complete ? 0 : null,
    };
    for (const f of facts)
      for (const field of ["points", "transfers", "hits", "bench"] as const)
        values[field] =
          values[field] === null || f[field] === null
            ? null
            : values[field] + f[field];
    totals.set(manager, values);
  }
  const metric = (read: (m: SampleManager) => number | null) =>
    sufficient ? mean(rows, read) : null;
  const total = (
    m: SampleManager,
    field: "points" | "transfers" | "hits" | "bench",
  ): number | null => {
    return totals.get(m)?.[field] ?? null;
  };
  const chipRate = (name: string, second: boolean) =>
    metric((m) =>
      m.chipsComplete && total(m, "points") !== null
        ? rangeFacts(m).filter((f) => f.chip === name && f.gw > 19 === second)
            .length
        : null,
    );
  return {
    avg_total_points: metric((m) => total(m, "points")),
    avg_transfers: metric((m) => total(m, "transfers")),
    avg_hits: metric((m) => {
      const cost = total(m, "hits");
      return cost === null ? null : cost / 4;
    }),
    avg_bench: metric((m) => total(m, "bench")),
    avg_captain_bonus: null,
    avg_gw_score: metric((m) => {
      const points = total(m, "points");
      const n = rangeFacts(m).length;
      return points === null || n === 0 ? null : points / n;
    }),
    wildcards_h1_rate: chipRate("wildcard", false),
    wildcards_h2_rate: chipRate("wildcard", true),
    free_hits_h1_rate: chipRate("freehit", false),
    free_hits_h2_rate: chipRate("freehit", true),
    bench_boosts_h1_rate: chipRate("bboost", false),
    bench_boosts_h2_rate: chipRate("bboost", true),
    triple_captains_h1_rate: chipRate("3xc", false),
    triple_captains_h2_rate: chipRate("3xc", true),
    sample_size: rows.length,
    with_hits_data: rows.filter((r) => total(r.manager, "hits") !== null)
      .length,
    with_bench_data: rows.filter((r) => total(r.manager, "bench") !== null)
      .length,
    with_transfers_data: rows.filter(
      (r) => total(r.manager, "transfers") !== null,
    ).length,
    with_captain_data: rows.filter((r) =>
      rangeFacts(r.manager).every((f) => f.captain !== null),
    ).length,
    with_chips_data: rows.filter(
      (r) => r.manager.chipsComplete && total(r.manager, "points") !== null,
    ).length,
  };
};

type BenchmarkInput = {
  season: string;
  gw: number;
  population: number;
  generatedAt: string;
  sourceRevision: string;
  finalized: boolean;
  managers: readonly SampleManager[];
  points: PlayerPoints;
  minimumCohort?: number;
  checkSquadScores?: boolean;
};
function* calculateSteps(
  input: BenchmarkInput,
): Generator<void, Benchmark, void> {
  const { gw, population, managers, points } = input;
  if (new Set(managers.map((m) => m.entry)).size !== managers.length)
    throw new Error("Duplicate sample managers");
  const sizes = populationSizes(population);
  const counts = strata.map(
    (s) => managers.filter((m) => m.stratum === s).length,
  ) as [number, number, number];
  for (const stratum of strata)
    if (sizes[stratum] > 0 && counts[stratum - 1] === 0)
      throw new Error(`Missing sample stratum ${stratum}`);
  const weighted = managers.map((manager) => {
    const facts: (ManagerFact | undefined)[] = Array.from({ length: gw + 1 });
    for (const fact of manager.facts) {
      if (facts[fact.gw]) throw new Error("Duplicate history GW");
      facts[fact.gw] = fact;
    }
    return {
      manager,
      facts,
      weight: sizes[manager.stratum] / (counts[manager.stratum - 1] ?? 1),
    };
  });
  const minimum = input.minimumCohort ?? 50;
  const complete = weighted.filter((r) => {
    if (!validSquad(r.manager.picks)) return false;
    if (!input.checkSquadScores || !input.finalized) return true;
    const fact = r.facts[gw];
    return (
      fact !== undefined &&
      fact.hits !== null &&
      sum(
        r.manager.picks,
        (p) => p.multiplier * (points.get(pointKey(p.element, gw)) ?? 0),
      ) -
        fact.hits ===
        fact.points
    );
  });
  // Nonresponse is normalized WITHIN the source sampling stratum. Never pool
  // the deliberately oversampled elite strata as equally representative people.
  const squadRows: Weighted[] = [];
  const squadCoverage = strata.every(
    (s) =>
      sizes[s] === 0 ||
      complete.filter((r) => r.manager.stratum === s).length >=
        (counts[s - 1] ?? 0) * 0.5,
  );
  if (squadCoverage)
    for (const stratum of strata) {
      const selected = complete.filter((r) => r.manager.stratum === stratum);
      for (const row of selected)
        squadRows.push({ ...row, weight: sizes[stratum] / selected.length });
    }
  const exposures: Exposure[] = [];
  for (let band = 0; band <= 9; band++) {
    if (gw === 1 && band !== 0) continue;
    const rows = squadRows.filter(
      (r) => band === 0 || pickRankBand(r.facts[gw - 1]?.rank) === band,
    );
    const denominator = sum(rows, (r) => r.weight);
    if (denominator <= 0) continue;
    const effectiveN = effectiveSampleSize(rows);
    const players = new Map<
      number,
      { squad: number; eo: number; cap: number; tc: number; intended: number }
    >();
    for (const row of rows)
      for (const pick of row.manager.picks) {
        const value = players.get(pick.element) ?? {
          squad: 0,
          eo: 0,
          cap: 0,
          tc: 0,
          intended: 0,
        };
        value.squad += row.weight;
        value.eo += row.weight * pick.multiplier;
        if (pick.multiplier === 2) value.cap += row.weight;
        if (pick.multiplier === 3) value.tc += row.weight;
        if (pick.captain) value.intended += row.weight;
        players.set(pick.element, value);
      }
    for (const [element, value] of players)
      exposures.push({
        band,
        element,
        ownership: Math.min(1, value.squad / denominator),
        eo: Math.min(3, value.eo / denominator),
        captainRate: value.cap / denominator,
        tripleCaptainRate: value.tc / denominator,
        intendedCaptainRate: value.intended / denominator,
        effectiveSampleSize: effectiveN,
      });
  }
  const bonus = (row: SampleManager): number | null =>
    !validSquad(row.picks)
      ? null
      : sum(
          row.picks,
          (p) =>
            Math.max(0, p.multiplier - 1) *
            (points.get(pointKey(p.element, gw)) ?? 0),
        );
  const sourceGroup = (limit: number) =>
    weighted.filter((r) => r.manager.stratum <= limit);
  const squadGroup = (limit: number) =>
    squadRows.filter((r) => r.manager.stratum <= limit);
  const bonusMean = (limit: number) => {
    const rows = squadGroup(limit);
    return effectiveSampleSize(rows) >= minimum ? mean(rows, bonus) : null;
  };
  const captainBonuses = {
    average: bonusMean(3),
    top100k: bonusMean(2),
    top10k: bonusMean(1),
  };
  const choices = (limit: number) => {
    const rows = squadGroup(limit),
      denominator = sum(rows, (r) => r.weight),
      counts = new Map<number, number>();
    if (
      effectiveSampleSize(rows) < minimum ||
      sum(
        rows.filter((r) => r.facts[gw]?.captain),
        (r) => r.weight,
      ) <
        denominator * 0.5
    )
      return [];
    for (const row of rows) {
      const captain = row.facts[gw]?.captain;
      if (captain) counts.set(captain, (counts.get(captain) ?? 0) + row.weight);
    }
    const observed = sum([...counts.values()], (n) => n);
    return [...counts].map(([element, n]) => ({ element, rate: n / observed }));
  };
  const captainChoices = {
    average: choices(3),
    top100k: choices(2),
    top10k: choices(1),
  };
  const ranges: Benchmark["ranges"] = [];
  // Fixed range ends permit one suffix sum per player, shared by all transfers.
  const suffixes = new Map<number, number[]>();
  const playerSuffix = (element: number, start: number): number => {
    let values = suffixes.get(element);
    if (!values) {
      values = Array<number>(gw + 2).fill(0);
      for (let g = gw; g >= 1; g--)
        values[g] =
          (values[g + 1] ?? 0) + (points.get(pointKey(element, g)) ?? 0);
      suffixes.set(element, values);
    }
    return values[start] ?? 0;
  };
  const transferWindows = new Map<SampleManager, (number | null)[]>();
  for (const manager of managers) {
    const values = Array<number>(gw + 1).fill(0),
      counts = Array<number>(gw + 1).fill(0);
    const chips = new Set(
      manager.facts
        .filter((f) => f.chip === "wildcard" || f.chip === "freehit")
        .map((f) => f.gw),
    );
    for (const t of manager.transfers)
      if (t.gw >= 1 && t.gw <= gw && !chips.has(t.gw)) {
        values[t.gw] =
          (values[t.gw] ?? 0) +
          playerSuffix(t.in, t.gw) -
          playerSuffix(t.out, t.gw);
        counts[t.gw] = (counts[t.gw] ?? 0) + 1;
      }
    const averages = Array<number | null>(gw + 1).fill(null);
    let value = 0,
      count = 0;
    for (let start = gw; start >= 1; start--) {
      value += values[start] ?? 0;
      count += counts[start] ?? 0;
      if (manager.transfersComplete && count > 0)
        averages[start] = value / count;
    }
    transferWindows.set(manager, averages);
  }
  for (let start = 1; start <= gw; start++) {
    const anchor = start === 1 ? gw : start - 1;
    const members = (max: number) =>
      weighted.filter((r) => {
        const rank = r.facts[anchor]?.rank;
        return rank !== null && rank !== undefined && rank > 0 && rank <= max;
      });
    const all = weighted; // Includes late entrants in the population at range end.
    const top100k = members(100_000),
      top10k = members(10_000);
    const buckets = new Map<
      string,
      { stratum: 1 | 2 | 3; score: number; managers: number }
    >();
    for (const row of weighted) {
      const facts = row.manager.facts.filter(
        (f) => f.gw >= start && f.gw <= gw,
      );
      const first = row.manager.facts[0]?.gw ?? gw + 1;
      if (facts.length !== gw - Math.max(start, first) + 1) continue;
      const score = sum(facts, (f) => f.points),
        key = `${row.manager.stratum}:${score}`;
      const bucket = buckets.get(key) ?? {
        stratum: row.manager.stratum,
        score,
        managers: 0,
      };
      bucket.managers++;
      buckets.set(key, bucket);
    }
    const transferValue = (m: SampleManager) =>
      transferWindows.get(m)?.[start] ?? null;
    const transfer = (rows: readonly Weighted[]) => {
      const observed = rows.filter((r) => r.manager.transfersComplete);
      const eligible = observed.filter(
        (r) => transferValue(r.manager) !== null,
      );
      return sum(observed, (r) => r.weight) >=
        sum(rows, (r) => r.weight) * 0.5 &&
        effectiveSampleSize(eligible) >= minimum
        ? mean(rows, transferValue, 0)
        : null;
    };
    const transferCoverage = (rows: readonly Weighted[]) => ({
      with_data: rows.filter((r) => r.manager.transfersComplete).length,
      with_transfers: rows.filter((r) => transferValue(r.manager) !== null)
        .length,
      stratum_size: rows.length,
    });
    ranges.push({
      startGw: start,
      cohorts: {
        average: aggregate(all, start, gw, minimum),
        top100k: aggregate(top100k, start, gw, minimum),
        top10k: aggregate(top10k, start, gw, minimum),
      },
      transferMeans: {
        average: transfer(all),
        top100k: transfer(top100k),
        top10k: transfer(top10k),
      },
      transferCoverage: {
        average: transferCoverage(all),
        top100k: transferCoverage(top100k),
        top10k: transferCoverage(top10k),
      },
      buckets: [...buckets.values()],
      stratumAverages: strata.map((s) =>
        mean(
          sourceGroup(s).filter((r) => r.manager.stratum === s),
          (m) =>
            sum(
              m.facts.filter((f) => f.gw >= start && f.gw <= gw),
              (f) => f.points,
            ),
        ),
      ) as [number | null, number | null, number | null],
    });
    yield;
  }
  return benchmarkSchema.parse({
    version: CALCULATION_VERSION,
    season: input.season,
    gw,
    population,
    sourceRevision: input.sourceRevision,
    generatedAt: input.generatedAt,
    finalized: input.finalized,
    sampleCounts: counts,
    captainBonuses,
    captainChoices,
    curve: null,
    exposures,
    ranges,
  });
}
export const calculateBenchmark = (input: BenchmarkInput): Benchmark => {
  const steps = calculateSteps(input);
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
};
// Keep the worker's lease heartbeat and shutdown signals responsive during a
// full-season calculation. The synchronous entry point remains useful in tests.
export const calculateBenchmarkAsync = async (
  input: BenchmarkInput,
): Promise<Benchmark> => {
  const steps = calculateSteps(input);
  let result = steps.next();
  while (!result.done) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    result = steps.next();
  }
  return result.value;
};
