import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateWeightedMidrank } from "./rangeStats.js";

void describe("estimateWeightedMidrank", () => {
  void it("places a manager in the middle of a tied score group", () => {
    const estimate = estimateWeightedMidrank(
      [
        {
          stratum: 1,
          sample_size: 100,
          strictly_higher: 20,
          tied: 10,
        },
      ],
      { 1: 1_000, 2: 0, 3: 0 },
      1_000,
    );

    assert.equal(estimate.rangeRank, 251);
    assert.deepEqual(estimate.sampleSizeByStratum, { 1: 100, 2: 0, 3: 0 });
  });

  void it("population-weights each independently sampled rank stratum", () => {
    const estimate = estimateWeightedMidrank(
      [
        {
          stratum: 1,
          sample_size: 100,
          strictly_higher: 10,
          tied: 0,
        },
        {
          stratum: 3,
          sample_size: 10,
          strictly_higher: 5,
          tied: 0,
        },
      ],
      { 1: 1_000, 2: 0, 3: 9_000 },
      10_000,
    );

    assert.equal(estimate.rangeRank, 4_601);
  });
});
