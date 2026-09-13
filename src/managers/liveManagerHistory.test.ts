import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlayerHistory } from "../types.js";
import { netPointsForEvent } from "./activityFilter.js";
import { withLiveManagerSummary } from "./liveManagerHistory.js";
import type { EntrySummary } from "./types.js";

const defaults = {
  rank: 0,
  rank_sort: 0,
  percentile_rank: 0,
  bank: 0,
  value: 1000,
  event_transfers: 0,
  points_on_bench: 0,
};
const history: PlayerHistory = {
  current: [
    {
      ...defaults,
      event: 3,
      points: 36,
      total_points: 198,
      overall_rank: 2523055,
      event_transfers_cost: 0,
    },
    {
      ...defaults,
      event: 4,
      points: 0,
      total_points: 198,
      overall_rank: 2523055,
      event_transfers_cost: 4,
    },
  ],
  chips: [],
  past: [],
};
const summary = {
  current_event: 4,
  summary_event_points: 48,
  summary_overall_points: 242,
  summary_overall_rank: 2264820,
} as EntrySummary;

void describe("live manager history", () => {
  void it("replaces a live zero placeholder with summary points/rank and retains hits", () => {
    const result = withLiveManagerSummary(history, summary, 4);
    assert.equal(result.current[1]?.points, 48);
    assert.equal(result.current[1]?.total_points, 242);
    assert.equal(result.current[1]?.overall_rank, 2264820);
    assert.equal(netPointsForEvent(result.current[1]), 44);
    assert.equal(result.current[0], history.current[0]);
    assert.equal(
      history.current[1]?.points,
      0,
      "the upstream cache stays unchanged",
    );
  });

  void it("preserves final history and rejects mismatched or missing live summaries", () => {
    assert.equal(withLiveManagerSummary(history, summary, null), history);
    assert.equal(withLiveManagerSummary(history, summary, 3), history);
    assert.equal(
      withLiveManagerSummary(
        history,
        { ...summary, summary_event_points: null },
        4,
      ),
      history,
    );
  });

  void it("accepts an actual zero live score", () => {
    const result = withLiveManagerSummary(
      history,
      { ...summary, summary_event_points: 0 },
      4,
    );
    assert.equal(result.current[1]?.points, 0);
    assert.equal(result.current[1]?.overall_rank, summary.summary_overall_rank);
  });
});
