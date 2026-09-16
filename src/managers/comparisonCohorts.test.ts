import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  combineCaptainBonusRows,
  combineCohortRows,
  combineComparisonCohortRows,
  comparisonCohortGw,
} from "./comparisonCohorts.js";

const row = (overrides: Record<string, number>) => ({
  stratum: 1 as const,
  sampleSize: 100,
  sumPoints: 5_000,
  sumGws: 100,
  completeTransfers: 100,
  sumTransfers: 100,
  completeHits: 100,
  sumHitsCost: 400,
  completeBench: 100,
  sumBench: 200,
  completeCaptain: 100,
  sumCaptain: 300,
  completeChips: 100,
  wildcardsH1: 10,
  wildcardsH2: 0,
  freehitsH1: 5,
  freehitsH2: 0,
  bboostsH1: 2,
  bboostsH2: 0,
  tripleCaptainsH1: 3,
  tripleCaptainsH2: 0,
  ...overrides,
});

void describe("combineCohortRows", () => {
  void it("uses population weights instead of raw sample counts", () => {
    const aggregate = combineCohortRows(
      [
        row({ stratum: 1, sampleSize: 100, sumPoints: 10_000 }),
        row({ stratum: 3, sampleSize: 10, sumPoints: 0 }),
      ],
      { 1: 10, 2: 0, 3: 90 },
    );

    assert.equal(aggregate.avg_total_points, 10);
  });

  void it("divides covered metrics only by managers with complete data", () => {
    const aggregate = combineCohortRows(
      [row({ completeHits: 60, sumHitsCost: 480 })],
      { 1: 100, 2: 0, 3: 0 },
    );

    assert.equal(aggregate.avg_hits, 2);
  });

  void it("hides a metric when complete coverage is below half", () => {
    const aggregate = combineCohortRows(
      [row({ completeBench: 49, sumBench: 98 })],
      { 1: 100, 2: 0, 3: 0 },
    );

    assert.equal(aggregate.avg_bench, null);
  });

  void it("includes Triple Captain in chip usage rates", () => {
    const aggregate = combineCohortRows([row({ tripleCaptainsH1: 12 })], {
      1: 100,
      2: 0,
      3: 0,
    });

    assert.equal(aggregate.triple_captains_h1_rate, 0.12);
  });
});

void describe("comparison cohorts", () => {
  void it("uses end-of-range rank for ranges beginning at GW1", () => {
    assert.equal(comparisonCohortGw(1, 1), 1);
    assert.equal(comparisonCohortGw(1, 6), 6);
  });

  void it("uses pre-range rank for ranges beginning after GW1", () => {
    assert.equal(comparisonCohortGw(2, 2), 1);
    assert.equal(comparisonCohortGw(7, 12), 6);
  });

  void it("returns Top 100k and Top 10k aggregates", () => {
    const aggregates = combineComparisonCohortRows(
      [
        row({ stratum: 1, sampleSize: 100, sumPoints: 10_000 }),
        row({ stratum: 2, sampleSize: 100, sumPoints: 5_000 }),
        row({ stratum: 3, sampleSize: 100, sumPoints: 0 }),
      ],
      { 1: 10, 2: 90, 3: 900 },
    );

    assert.equal(aggregates.top10k.avg_total_points, 100);
    assert.equal(aggregates.top100k.avg_total_points, 55);
    assert.equal(aggregates.average.avg_total_points, 5.5);
  });
});

void describe("combineCaptainBonusRows", () => {
  const captainRow = (
    gw: number,
    stratum: 1 | 2 | 3,
    avgBonus: number,
    sampleSize: number,
    rankedPopulation = 1_000_000,
  ) => ({
    stratum,
    gw,
    avg_bonus: avgBonus,
    sample_size: sampleSize,
    ranked_population: rankedPopulation,
  });

  void it("sums per-GW averages and population-weights rank strata", () => {
    const averages = combineCaptainBonusRows(
      [
        captainRow(1, 1, 10, 500),
        captainRow(1, 2, 5, 1_000),
        captainRow(1, 3, 1, 1_500),
        captainRow(2, 1, 8, 500),
        captainRow(2, 2, 4, 1_000),
        captainRow(2, 3, 2, 1_500),
      ],
      1,
      2,
    );

    assert.equal(averages.top10k, 18);
    assert.ok(Math.abs((averages.top100k ?? 0) - 9.9) < 1e-12);
    assert.ok(Math.abs((averages.average ?? 0) - 3.69) < 1e-12);
  });

  void it("requires every GW and a sufficient sample", () => {
    const missingGw = combineCaptainBonusRows(
      [
        captainRow(1, 1, 10, 500),
        captainRow(1, 2, 5, 1_000),
        captainRow(1, 3, 1, 1_500),
      ],
      1,
      2,
    );
    assert.deepEqual(missingGw, {
      average: null,
      top100k: null,
      top10k: null,
    });

    const thinSample = combineCaptainBonusRows(
      [
        captainRow(1, 1, 10, 200),
        captainRow(1, 2, 5, 300),
        captainRow(1, 3, 1, 400),
      ],
      1,
      1,
    );
    assert.deepEqual(thinSample, {
      average: null,
      top100k: null,
      top10k: null,
    });
  });

  void it("does not require rank strata with no real population", () => {
    const averages = combineCaptainBonusRows(
      [captainRow(1, 1, 7, 1_500, 5_000)],
      1,
      1,
    );

    assert.deepEqual(averages, {
      average: 7,
      top100k: 7,
      top10k: 7,
    });
  });

  void it("rejects an overall average when a populated stratum is absent", () => {
    const averages = combineCaptainBonusRows(
      [captainRow(1, 1, 10, 500), captainRow(1, 2, 5, 1_000)],
      1,
      1,
    );

    assert.equal(averages.average, null);
    assert.equal(averages.top100k, 5.5);
    assert.equal(averages.top10k, 10);
  });
});
