import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRankMovementEstimator } from "./rankMovement.js";

void describe("createRankMovementEstimator", () => {
  void it("uses the local score distribution instead of a fixed coefficient", () => {
    const estimator = createRankMovementEstimator([
      { score: 68, rank: 100 },
      { score: 67, rank: 300 },
      { score: 66, rank: 700 },
      { score: 65, rank: 1_500 },
      { score: 64, rank: 3_100 },
      { score: 63, rank: 6_300 },
    ]);

    assert.ok(estimator);
    const onePoint = estimator.impactForExcess(67, 1);
    const fourPoints = estimator.impactForExcess(67, 4);
    assert.ok(onePoint > 0);
    assert.ok(fourPoints > onePoint * 4, "denser scores should cost more rank");
  });

  void it("keeps gains positive, losses negative, and interpolates fractions", () => {
    const estimator = createRankMovementEstimator([
      { score: 11, rank: 10 },
      { score: 10, rank: 30 },
      { score: 9, rank: 70 },
    ]);

    assert.ok(estimator);
    assert.ok(estimator.impactForExcess(10, 0.5) > 0);
    assert.ok(estimator.impactForExcess(10, -0.5) < 0);
    assert.equal(estimator.impactForExcess(10, 0), 0);
  });

  void it("returns null for an empty distribution", () => {
    assert.equal(createRankMovementEstimator([]), null);
  });
});
