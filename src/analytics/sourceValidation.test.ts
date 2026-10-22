import assert from "node:assert/strict";
import { test } from "node:test";
import {
  historySchema,
  transfersSchema,
} from "../managers/sourceValidation.js";
import { errorInfo, AnalyticsError } from "./errors.js";
import { validSquad } from "./model.js";
import { squad } from "./testing/fixtures.js";

void test("external schemas preserve repeated transfers and reject malformed history", () => {
  const transfer = {
    element_in: 2,
    element_in_cost: 45,
    element_out: 1,
    element_out_cost: 45,
    entry: 1,
    event: 3,
  };
  assert.equal(transfersSchema.parse([transfer, transfer]).length, 2);
  const f = {
    event: 1,
    points: 0,
    total_points: 0,
    rank: null,
    rank_sort: null,
    overall_rank: null,
    bank: 0,
    value: 1000,
    event_transfers: 0,
    event_transfers_cost: 0,
    points_on_bench: 0,
  };
  const history = { current: [f], past: [], chips: [] };
  assert.equal(historySchema.parse(history).current[0]?.overall_rank, 0);
  assert.equal(
    historySchema.safeParse({ ...history, current: [f, f] }).success,
    false,
  );
  assert.equal(
    historySchema.safeParse({
      ...history,
      chips: [{ name: "unknown-chip", time: "now", event: 1 }],
    }).success,
    false,
  );
  const picks = squad();
  picks[0]!.vice = true;
  picks[1]!.vice = false;
  assert.equal(validSquad(picks), false);
});
void test("failure classification separates dependency waits, schema drift, and database outages", () => {
  assert.equal(
    errorInfo(new AnalyticsError("benchmark_unavailable", "waiting")).retryable,
    true,
  );
  assert.equal(errorInfo({ code: "57014" }).code, "database_unavailable");
  const malformed = historySchema.safeParse({});
  assert.equal(malformed.success, false);
  if (!malformed.success) {
    assert.equal(errorInfo(malformed.error).code, "source_schema_changed");
    assert.equal(errorInfo(malformed.error).retryable, false);
  }
  assert.equal(errorInfo({ response: { status: 404 } }).status, 404);
});
