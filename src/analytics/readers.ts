import type { ComparisonCohorts } from "../managers/comparisonCohorts.js";
import type { CaptainRateInfo } from "../managers/rankImpact.js";
import type { RankBand } from "../managers/rankBands.js";
import { loadBenchmarks, publishedRange } from "./store.js";

export const readComparison = async (
  start: number,
  end: number,
): Promise<ComparisonCohorts> => {
  const [{ range }, context] = await Promise.all([
    publishedRange(start, end),
    loadBenchmarks(start, end),
  ]);
  const captainTotal = (
    side: "average" | "top100k" | "top10k",
  ): number | null => {
    let total = 0;
    for (let gw = start; gw <= end; gw++) {
      const value = context.snapshots.get(gw)?.captainBonuses[side];
      if (value === null || value === undefined) return null;
      total += value;
    }
    return total;
  };
  const captainChoice = (side: "average" | "top100k" | "top10k") => {
    const totals = new Map<number, number>();
    for (let gw = start; gw <= end; gw++) {
      const choices = context.snapshots.get(gw)?.captainChoices[side];
      if (!choices?.length) return { player_id: null, sample_complete: false };
      for (const choice of choices)
        totals.set(
          choice.element,
          (totals.get(choice.element) ?? 0) + choice.rate,
        );
    }
    const first = [...totals].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    return { player_id: first?.[0] ?? null, sample_complete: !!first };
  };
  return {
    ...range.cohorts,
    averageCaptain: captainChoice("average"),
    top100kCaptain: captainChoice("top100k"),
    top10kCaptain: captainChoice("top10k"),
    average: {
      ...range.cohorts.average,
      avg_captain_bonus: captainTotal("average"),
    },
    top100k: {
      ...range.cohorts.top100k,
      avg_captain_bonus: captainTotal("top100k"),
    },
    top10k: {
      ...range.cohorts.top10k,
      avg_captain_bonus: captainTotal("top10k"),
    },
  };
};
export const readCaptainRates = async (
  bands: ReadonlyMap<number, RankBand | 0 | null>,
  start: number,
  end: number,
): Promise<CaptainRateInfo> => {
  const context = await loadBenchmarks(start, end);
  const rates: CaptainRateInfo["rates"] = new Map(),
    perGwSampleSize = new Map<number, number>();
  for (let gw = start; gw <= end; gw++) {
    const band = bands.get(gw);
    if (band === null || band === undefined) continue;
    for (const exposure of context.snapshots.get(gw)?.exposures ?? [])
      if (exposure.band === band) {
        rates.set(`${exposure.element}:${gw}`, {
          cap_rate: exposure.captainRate,
          tc_rate: exposure.tripleCaptainRate,
        });
        perGwSampleSize.set(gw, exposure.effectiveSampleSize);
      }
  }
  return { rates, perGwSampleSize };
};
export const readExposure = async (
  bands: ReadonlyMap<number, RankBand | 0 | null>,
  ids: readonly number[],
  start: number,
  end: number,
) => {
  const context = await loadBenchmarks(start, end),
    wanted = new Set(ids);
  const exposures = new Map<
      string,
      { ownership_pct: number; eo: number; sample_size: number }
    >(),
    perGwSampleSize = new Map<number, number>();
  for (let gw = start; gw <= end; gw++)
    for (const row of context.snapshots.get(gw)?.exposures ?? []) {
      if (bands.get(gw) !== row.band) continue;
      perGwSampleSize.set(gw, row.effectiveSampleSize);
      if (wanted.has(row.element))
        exposures.set(`${row.element}:${gw}`, {
          ownership_pct: row.ownership,
          eo: row.eo,
          sample_size: row.effectiveSampleSize,
        });
    }
  return { exposures, perGwSampleSize };
};
export const readTop10kCaptain = async (
  start: number,
  end: number,
): Promise<Map<number, number>> => {
  const context = await loadBenchmarks(start, end),
    result = new Map<number, number>();
  for (let gw = start; gw <= end; gw++) {
    if (gw === 1) {
      const choice = [
        ...(context.snapshots.get(gw)?.captainChoices.top10k ?? []),
      ].sort((a, b) => b.rate - a.rate || a.element - b.element)[0];
      if (choice) result.set(gw, choice.element);
      continue;
    }
    const rows =
      context.snapshots
        .get(gw)
        ?.exposures.filter(
          (r) => r.band === 1 && r.effectiveSampleSize >= 50,
        ) ?? [];
    const first = rows.sort(
      (a, b) =>
        b.intendedCaptainRate - a.intendedCaptainRate || a.element - b.element,
    )[0];
    if (first && first.intendedCaptainRate > 0) result.set(gw, first.element);
  }
  return result;
};
