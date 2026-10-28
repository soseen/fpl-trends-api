import assert from "node:assert/strict";
import { it } from "node:test";
import { auditTop10kRange } from "./auditTop10k.js";
import { benchmarkSourceSchema } from "./model.js";
import { manager } from "./testing/fixtures.js";

void it("reports follow-up availability without treating overlap as a representative cohort", () => {
  const a = manager(1, 1);
  const b = manager(2, 1);
  const c = manager(3, 2);
  const d = manager(4, 3);
  a.cluster = 1;
  b.cluster = 2;
  b.facts[0]!.rank = 9000;
  c.facts[0]!.rank = 9000;
  const source = (gw: number, managers: (typeof a)[]) =>
    benchmarkSourceSchema.parse({
      format: 1,
      checkSquadScores: true,
      season: "2026-27",
      gw,
      population: 1000000,
      managers,
      points: [],
    });
  const report = auditTop10kRange(source(1, [a, b]), source(3, [b, c, d]));
  assert.equal(report.anchorManagers, 2);
  assert.equal(report.anchorWithKnownPage, 2);
  assert.equal(report.anchorPages, 2);
  assert.equal(report.anchorAlsoInEndSample, 1);
  assert.equal(report.endSamplePriorElite, 2);
  assert.ok(report.endSampleEffectiveSize < 2);
  assert.equal(report.endSampleCompleteHistory, 2);
  assert.throws(() => auditTop10kRange(source(3, [a]), source(1, [a])));
});
