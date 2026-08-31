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

  void it("produces realistic non-linear impacts from an official standings curve", () => {
    const estimator = createRankMovementEstimator([
      { score: 148, rank: 2_104_830 },
      { score: 166, rank: 649_183 },
      { score: 172, rank: 394_127 },
      { score: 183, rank: 124_318 },
      { score: 194, rank: 35_000 },
    ]);

    assert.ok(estimator);
    const brunoCaptainGain = estimator.impactForExcess(172, 21.5);
    const haalandLoss = estimator.impactForExcess(172, -11.3);
    const whiteGain = estimator.impactForExcess(172, 6.2);

    assert.ok(brunoCaptainGain > 1_000_000);
    assert.ok(whiteGain > 250_000);
    assert.ok(haalandLoss < -200_000);
    assert.ok(Math.abs(haalandLoss) <= 394_126);
  });
});
