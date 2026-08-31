import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effectivePointExcess } from "./teamImpactCalc.js";

void describe("effectivePointExcess", () => {
  void it("uses EO as a multiplier for captain and ordinary-player gains", () => {
    assert.ok(
      Math.abs(effectivePointExcess(2, 1.066, 23) - 21.482) < 0.000_001,
    );
    assert.ok(Math.abs(effectivePointExcess(1, 0.115, 7) - 6.195) < 0.000_001);
  });

  void it("makes an unowned high-EO return a rank cost", () => {
    assert.ok(
      Math.abs(effectivePointExcess(0, 0.866, 13) + 11.258) < 0.000_001,
    );
  });

  void it("retains negative scores so they offset multi-GW rank-killer cost", () => {
    const positiveWeek = effectivePointExcess(0, 0.8, 10);
    const negativeWeek = effectivePointExcess(0, 0.8, -1);
    assert.equal(positiveWeek, -8);
    assert.equal(negativeWeek, 0.8);
    assert.equal(positiveWeek + negativeWeek, -7.2);
  });
});
