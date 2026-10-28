import assert from "node:assert/strict";
import { it } from "node:test";
import { waitForFollowupCapacity } from "./populateManagers.js";

void it("waits for both an idle worker and available memory", async () => {
  let time = 0,
    count = 0;
  const ok = await waitForFollowupCapacity({
    now: () => time,
    pause: (ms) => {
      time += ms;
      return Promise.resolve();
    },
    pending: () => Promise.resolve(count++ === 0 ? 1 : 0),
    availableMemory: () => (count < 3 ? 0 : 2 * 1024 ** 3),
    timeoutMs: 20000,
  });
  assert.equal(ok, true);
  assert.equal(time, 10000);
});

void it("defers collection when memory is unavailable", async () => {
  let time = 0;
  assert.equal(
    await waitForFollowupCapacity({
      now: () => time,
      pause: (ms) => {
        time += ms;
        return Promise.resolve();
      },
      pending: () => Promise.resolve(0),
      availableMemory: () => 0,
      timeoutMs: 10000,
    }),
    false,
  );
});
