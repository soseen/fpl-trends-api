import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldResetCurrentGwSample } from "./populateManagers.js";

void describe("shouldResetCurrentGwSample", () => {
  void it("clears same-numbered stale rows when entering a new live GW", () => {
    assert.equal(
      shouldResetCurrentGwSample({
        sampleGw: 2,
        currentGw: 3,
        isLiveCurrentGw: true,
        sampleGwFinalized: 1,
        sampleGwCleaned: 2,
      }),
      true,
    );
  });

  void it("keeps an in-progress sample for the same live GW", () => {
    assert.equal(
      shouldResetCurrentGwSample({
        sampleGw: 3,
        currentGw: 3,
        isLiveCurrentGw: true,
        sampleGwFinalized: 0,
        sampleGwCleaned: 3,
      }),
      false,
    );
  });

  void it("rebuilds a live sample once that GW becomes finished", () => {
    assert.equal(
      shouldResetCurrentGwSample({
        sampleGw: 3,
        currentGw: 3,
        isLiveCurrentGw: false,
        sampleGwFinalized: 0,
        sampleGwCleaned: 3,
      }),
      true,
    );
  });

  void it("resumes an already-cleaned finished-GW rebuild", () => {
    assert.equal(
      shouldResetCurrentGwSample({
        sampleGw: 3,
        currentGw: 3,
        isLiveCurrentGw: false,
        sampleGwFinalized: 2,
        sampleGwCleaned: 3,
      }),
      false,
    );
  });
});
