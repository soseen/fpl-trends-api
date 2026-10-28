import assert from "node:assert/strict";
import { it } from "node:test";
import { calculateBenchmark, calculateFollowedTop10k } from "./calculate.js";
import { selectFollowup } from "./followTop10k.js";
import {
  benchmarkSourceSchema,
  hasCompleteTransferWindow,
  type SampleManager,
} from "./model.js";
import { manager } from "./testing/fixtures.js";

void it("selects a reproducible follow-up from a complete prior cohort", () => {
  const roster = Array.from({ length: 10000 }, (_, i) => {
    const m = manager(i + 1, 1);
    m.facts[0]!.rank = i + 1;
    return m;
  });
  const source = benchmarkSourceSchema.parse({
    format: 1,
    checkSquadScores: true,
    season: "2026-27",
    gw: 1,
    population: 1000000,
    managers: roster,
    points: [],
  });
  const first = selectFollowup(source).map((m) => m.entry);
  assert.equal(first.length, 300);
  source.managers.reverse();
  assert.deepEqual(
    selectFollowup(source).map((m) => m.entry),
    first,
  );
  source.managers.pop();
  assert.throws(() => selectFollowup(source), /complete archived/);
});

void it("uses the followed prior cohort for all range metrics and rejects incomplete follow-up", () => {
  const source = [manager(1, 1), manager(2, 2), manager(3, 3)];
  const followed: SampleManager[] = Array.from({ length: 300 }, (_, i) => {
    const m = manager(i + 100, 1);
    m.facts[0]!.rank = i + 1;
    m.facts[1]!.points = 12;
    m.facts[2]!.points = 8;
    m.facts[2]!.rank = 200000;
    m.facts[1]!.transfers = 1;
    m.transfers = [{ gw: 2, in: 2, out: 1 }];
    return m;
  });
  const input = {
    season: "2026-27",
    gw: 3,
    population: 1000000,
    generatedAt: "2026-10-22T12:00:00.000Z",
    sourceRevision: "fixture",
    finalized: true,
    managers: source,
    points: new Map([
      ["1:2", 1],
      ["1:3", 1],
      ["2:2", 4],
      ["2:3", 4],
    ]),
    followedTop10k: [
      {
        startGw: 2,
        anchorRevision: "anchor",
        selectedEntries: followed.map((m) => m.entry),
        managers: followed,
      },
    ],
  };
  const result = calculateBenchmark(input);
  assert.equal(result.ranges[1]?.cohorts.top10k.avg_total_points, 20);
  assert.equal(result.ranges[1]?.cohorts.top10k.avg_gw_score, 10);
  assert.equal(result.ranges[1]?.transferMeans.top10k, 6);
  assert.equal(result.ranges[1]?.cohorts.top10k.sample_size, 300);
  const replacement = calculateFollowedTop10k(followed, 2, 3, input.points);
  assert.deepEqual(replacement.cohort, result.ranges[1]?.cohorts.top10k);
  assert.equal(
    replacement.transferMean,
    result.ranges[1]?.transferMeans.top10k,
  );
  assert.deepEqual(
    replacement.transferCoverage,
    result.ranges[1]?.transferCoverage.top10k,
  );
  for (const m of followed.slice(0, 4)) m.transfersComplete = false;
  assert.equal(
    calculateFollowedTop10k(followed, 2, 3, input.points).transferMean,
    null,
  );
  assert.equal(calculateBenchmark(input).ranges[1]?.transferMeans.top10k, null);
  assert.equal(
    calculateBenchmark(input).ranges[1]?.cohorts.top10k.avg_total_points,
    20,
  );
  for (const m of followed.slice(0, 4)) m.transfersComplete = true;
  input.followedTop10k[0]!.managers = followed.slice(0, 297);
  assert.equal(
    calculateBenchmark(input).ranges[1]?.cohorts.top10k.sample_size,
    297,
  );
  input.followedTop10k[0]!.managers = followed.slice(0, 296);
  assert.throws(() => calculateBenchmark(input), /Invalid followed Top 10k/);
  input.followedTop10k[0]!.managers = followed;
  followed[0]!.facts = followed[0]!.facts.filter((f) => f.gw !== 3);
  assert.throws(() => calculateBenchmark(input), /Invalid followed Top 10k/);
});

void it("reconciles transfers only inside the selected range and excludes chip transfers", () => {
  const m = manager(1, 1);
  m.facts[0]!.transfers = 1;
  m.facts[1]!.transfers = 1;
  m.facts[2]!.chip = "wildcard";
  m.transfers = [
    { gw: 2, in: 2, out: 1 },
    { gw: 3, in: 3, out: 4 },
  ];
  assert.equal(hasCompleteTransferWindow(m, 2, 3), true);
  assert.equal(hasCompleteTransferWindow(m, 1, 3), false);
  m.facts[1]!.transfers = 2;
  assert.equal(hasCompleteTransferWindow(m, 2, 3), false);
});
