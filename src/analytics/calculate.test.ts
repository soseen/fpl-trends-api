import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateBenchmark } from "./calculate.js";
import {
  rawTransferAverage,
  validSquad,
  benchmarkSourceSchema,
  type SampleManager,
} from "./model.js";
import { samplePages } from "./sampling.js";
import { captainPicksFromResolved } from "../managers/resolvePicks.js";
import { createRankMovementEstimator } from "../managers/rankMovement.js";
import { conditionalCaptainMultiplier } from "../managers/captainMultiplier.js";
import { calibrateRanks } from "./calibrate.js";

import { squad, manager } from "./testing/fixtures.js";
const input = (managers: SampleManager[]) => ({
  season: "2026-27",
  gw: 3,
  population: 1_000_000,
  generatedAt: "2026-10-22T12:00:00.000Z",
  sourceRevision: "fixture",
  finalized: true,
  managers,
  minimumCohort: 1,
  points: new Map([
    ["1:3", 6],
    ["2:3", -2],
  ]),
});
const close = (a: number | null | undefined, b: number) => {
  assert.ok(a !== null && a !== undefined);
  assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
};

void describe("independent weighted reference examples", () => {
  void it("holds whole page clusters out of rank calibration", () => {
    const managers = Array.from({ length: 60 }, (_, i) => ({
      ...manager(i + 1, (Math.floor(i / 20) + 1) as 1 | 2 | 3),
      cluster: 1 + Math.floor((i % 20) / 2),
    }));
    const report = calibrateRanks(
      benchmarkSourceSchema.parse({
        format: 1,
        checkSquadScores: true,
        season: "2026-27",
        gw: 3,
        population: 1000000,
        managers,
        points: [],
      }),
    );
    assert.ok(report.heldOut > 0);
    assert.equal(report.heldOut % 2, 0);
    assert.equal(report.inferredClusters, 0);
    for (const n of report.trainingByStratum) assert.equal(n % 2, 0);
  });
  void it("withholds EO and captain benchmarks when finalized squads do not reconcile", () => {
    const rows = [manager(1, 1), manager(2, 2), manager(3, 3)];
    for (const row of rows) row.facts[2]!.points = 12;
    const points = new Map(
      Array.from({ length: 15 }, (_, i) => [`${i + 1}:3`, 1]),
    );
    assert.ok(
      calculateBenchmark({ ...input(rows), points, checkSquadScores: true })
        .exposures.length > 0,
    );
    rows[2]!.facts[2]!.points = 999;
    const result = calculateBenchmark({
      ...input(rows),
      points,
      checkSquadScores: true,
    });
    assert.equal(result.exposures.length, 0);
    assert.equal(result.captainBonuses.average, null);
  });
  void it("conditions representative triple-captain multipliers on actual captainers", () => {
    close(conditionalCaptainMultiplier({ cap_rate: 0.1, tc_rate: 0.1 }), 2.5);
    close(conditionalCaptainMultiplier({ cap_rate: 0, tc_rate: 0.01 }), 3);
    close(conditionalCaptainMultiplier(undefined), 2);
  });
  void it("matches the independent transfer reference for every range start", () => {
    const rows = [manager(1, 1), manager(2, 2), manager(3, 3)];
    const points = new Map([
      ["1:1", 4],
      ["1:2", -1],
      ["1:3", 2],
      ["2:1", 1],
      ["2:2", 6],
      ["2:3", -3],
    ]);
    for (const row of rows)
      row.transfers = [
        { gw: 1, in: 2, out: 1 },
        { gw: 3, in: 1, out: 2 },
      ];
    rows[1]!.facts[0]!.chip = "wildcard";
    const result = calculateBenchmark({ ...input(rows), points });
    for (let start = 1; start <= 3; start++) {
      const expected = rows.reduce(
        (s, m, i) =>
          s +
          (rawTransferAverage(m, points, start, 3) ?? 0) *
            [0.01, 0.09, 0.9][i]!,
        0,
      );
      close(result.ranges[start - 1]?.transferMeans.average, expected);
    }
  });
  void it("matches a manually expanded stratified population, including negative scores", () => {
    const rows = [manager(1, 1), manager(2, 2), manager(3, 3)];
    rows[2]!.facts[2]!.points = -5;
    const result = calculateBenchmark(input(rows));
    // Independent census expansion: 10k,90k,900k people, one observation each.
    const expected = (10_000 * 13 + 90_000 * 23 + 900_000 * -5) / 1_000_000;
    close(result.ranges[2]?.cohorts.average.avg_total_points, expected);
    assert.equal(result.ranges.length, 3);
  });
  void it("keeps the prior-rank cohort while weighting by the actual source sampling design", () => {
    const rows = [manager(1, 1), manager(2, 2), manager(3, 3)];
    rows[0]!.facts[0]!.rank = 500000;
    rows[1]!.facts[0]!.rank = 5000;
    rows[2]!.facts[0]!.rank = 5000;
    const result = calculateBenchmark(input(rows));
    close(
      result.ranges[1]?.cohorts.top10k.avg_total_points,
      (90_000 * 45 + 900_000 * 65) / 990_000,
    );
    close(result.ranges[0]?.cohorts.top10k.avg_total_points, 36);
  });
  void it("requires every nonempty source stratum and rejects duplicate identities", () => {
    assert.throws(
      () => calculateBenchmark(input([manager(1, 1)])),
      /Missing sample stratum/,
    );
    assert.throws(
      () =>
        calculateBenchmark(
          input([manager(1, 1), manager(1, 2), manager(3, 3)]),
        ),
      /Duplicate/,
    );
  });
  void it("keeps a genuine zero distinct from missing data, and gates coverage by population weight", () => {
    const rows = [manager(1, 1), manager(2, 2), manager(3, 3)];
    rows[2]!.facts[1]!.bench = null;
    const result = calculateBenchmark(input(rows));
    assert.equal(result.ranges[1]?.cohorts.average.avg_bench, null);
    assert.equal(result.ranges[1]?.cohorts.top10k.avg_bench, 0);
  });
  void it("includes late entrants in population means without inventing a prior elite rank", () => {
    const rows = [manager(1, 1), manager(2, 2), manager(3, 3)];
    rows[2]!.facts = rows[2]!.facts.slice(2);
    const result = calculateBenchmark(input(rows));
    close(
      result.ranges[0]?.cohorts.average.avg_total_points,
      (10_000 * 36 + 90_000 * 66 + 900_000 * 33) / 1_000_000,
    );
    assert.equal(result.ranges[1]?.cohorts.top10k.sample_size, 1);
  });
  void it("stores weighted EO directly, without rounding through an effective sample count", () => {
    const rows = [manager(1, 1), manager(2, 2), manager(3, 3)];
    rows[2]!.picks[0]!.multiplier = 0;
    const result = calculateBenchmark(input(rows));
    const player = result.exposures.find(
      (r) => r.band === 0 && r.element === 1,
    );
    close(player?.ownership, 1);
    close(player?.eo, 0.2);
    close(player?.captainRate, 0.1);
    assert.ok(player && player.effectiveSampleSize < 2);
  });
  void it("credits a promoted vice's actual triple captain bonus while retaining intended choice", () => {
    const rows = [manager(1, 1), manager(2, 2), manager(3, 3)];
    for (const row of rows) {
      row.picks[0]!.multiplier = 0;
      row.picks[1]!.multiplier = 3;
    }
    const result = calculateBenchmark(input(rows));
    close(result.captainBonuses.average, -4);
    close(
      result.exposures.find((r) => r.band === 0 && r.element === 1)
        ?.intendedCaptainRate,
      1,
    );
    close(
      result.exposures.find((r) => r.band === 0 && r.element === 2)
        ?.tripleCaptainRate,
      1,
    );
    const captains = captainPicksFromResolved(
      {
        incomplete: false,
        picks: rows[0]!.picks.map((p) => ({
          entry_id: 1,
          gw: 3,
          element_id: p.element,
          position: p.position,
          multiplier: p.multiplier,
          is_captain: p.captain,
          is_vice: p.vice,
        })),
      },
      [3],
    );
    assert.equal(captains[0]?.captain_element, 2);
    assert.equal(captains[0]?.captain_multiplier, 3);
  });
  void it("rejects incomplete, duplicate and malformed squad snapshots", () => {
    assert.equal(validSquad(squad()), true);
    assert.equal(validSquad(squad().slice(1)), false);
    const duplicate = squad();
    duplicate[14]!.element = 1;
    assert.equal(validSquad(duplicate), false);
    const captains = squad();
    captains[1]!.multiplier = 2;
    assert.equal(validSquad(captains), false);
  });
  void it("uses identical raw transfer windows for user and population benchmarks", () => {
    const row = manager(1, 1);
    row.transfers = [
      { gw: 2, in: 2, out: 1 },
      { gw: 2, in: 3, out: 2 },
      { gw: 3, in: 1, out: 3 },
    ];
    const points = new Map([
      ["1:2", 4],
      ["1:3", -2],
      ["2:2", 10],
      ["2:3", 3],
      ["3:2", 1],
      ["3:3", 5],
    ]);
    // (13-2) + (6-13) + (-2-5) = -3, averaged over three operations.
    assert.equal(rawTransferAverage(row, points, 2, 3), -1);
    row.facts[1]!.chip = "freehit";
    assert.equal(rawTransferAverage(row, points, 2, 3), -7);
    row.transfers = [];
    assert.equal(rawTransferAverage(row, points, 2, 3), null);
  });
  void it("preserves nonlinear rank impact and sums per-GW marginal contributions", () => {
    const curve = createRankMovementEstimator([
      { score: 0, rank: 10000 },
      { score: 10, rank: 9000 },
      { score: 20, rank: 1000 },
      { score: 30, rank: 1 },
    ]);
    assert.ok(curve);
    const end = 21;
    let previous = 0,
      excess = 0,
      total = 0;
    for (const value of [3, -2, 1, 0, -0.5]) {
      excess += value;
      const now = curve.impactForExcess(end, excess);
      total += now - previous;
      previous = now;
    }
    close(total, curve.impactForExcess(end, 1.5));
  });
  void it("bounds and reproduces page-cluster samples without a hardcoded population tail", () => {
    const first = samplePages(2001, 400000, 400, "season:gw");
    assert.equal(first.length, 400);
    assert.equal(new Set(first).size, 400);
    assert.ok(Math.max(...first) > 252000);
    assert.deepEqual(first, samplePages(2001, 400000, 400, "season:gw"));
    assert.notDeepEqual(
      first,
      samplePages(2001, 400000, 400, "season:next-gw"),
    );
  });
});
