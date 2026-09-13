import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { prisma } from "../database/client.js";
import { overallRankMovementCurve } from "./rangeStats.js";

const replaceMethod = (
  t: TestContext,
  target: object,
  name: string,
  replacement: (...args: never[]) => unknown,
): void => {
  const original: unknown = Reflect.get(target, name);
  Reflect.set(target, name, replacement);
  t.after(() => {
    Reflect.set(target, name, original);
  });
};

void it("rejects a top-100k-only live snapshot and uses a coherent recent sample", async (t) => {
  replaceMethod(t, prisma.events, "findUnique", () => ({
    finished: false,
    is_current: true,
  }));
  replaceMethod(t, prisma.overall_rank_curve_snapshots, "findUnique", () => ({
    max_rank: 99474,
    captured_at: new Date(),
    is_final: false,
    points: [
      { score: 294, rank: 99474 },
      { score: 385, rank: 1 },
    ],
  }));
  replaceMethod(t, prisma.manager_summary, "aggregate", () => ({
    _max: { last_updated: new Date() },
  }));
  replaceMethod(t, prisma, "$queryRawUnsafe", (query: string) =>
    query.includes("AS population")
      ? [{ population: 10408519 }]
      : Array.from({ length: 5 }, (_, i) => ({
          score: 240 + i,
          rank: 3000000 - i * 100000,
          sample_size: 100,
        })),
  );

  const curve = await overallRankMovementCurve(4);
  assert.equal(curve.source, "recent_manager_sample");
  assert.equal(curve.status, "provisional");
  assert.ok(curve.estimator);
  assert.ok(curve.estimator.impactForExcess(242, 1) > 0);
});

void it("reports unavailable when neither a complete curve nor a recent sample exists", async (t) => {
  replaceMethod(t, prisma.events, "findUnique", () => ({
    finished: false,
    is_current: true,
  }));
  replaceMethod(t, prisma.overall_rank_curve_snapshots, "findUnique", () => ({
    max_rank: 99474,
  }));
  replaceMethod(t, prisma.manager_summary, "aggregate", () => ({
    _max: { last_updated: null },
  }));
  replaceMethod(t, prisma, "$queryRawUnsafe", (query: string) =>
    query.includes("AS population") ? [{ population: 10408519 }] : [],
  );

  const curve = await overallRankMovementCurve(4);
  assert.equal(curve.estimator, null);
  assert.equal(curve.status, "unavailable");
});
