import assert from "node:assert/strict";
import { test } from "node:test";
import {
  retryAfterMilliseconds,
  observeFplBackoff,
  fplBackoffRemaining,
} from "./fplBackoff.js";
import axios from "axios";
void test("upstream backoff accepts seconds and HTTP-date Retry-After values", () => {
  assert.equal(retryAfterMilliseconds("120"), 120000);
  assert.equal(
    retryAfterMilliseconds(
      "Thu, 22 Oct 2026 12:01:00 GMT",
      Date.parse("2026-10-22T12:00:00Z"),
    ),
    60000,
  );
  assert.equal(retryAfterMilliseconds(undefined), 60000);
  assert.equal(retryAfterMilliseconds("-1"), 1000);
});
void test("rate limiting blocks other manager clients during the shared cooldown", async () => {
  let attempts = 0;
  const client = axios.create({
    adapter: (config) => {
      attempts++;
      return Promise.reject(
        new axios.AxiosError(
          "rate limited",
          "ERR_BAD_RESPONSE",
          config,
          undefined,
          {
            status: 429,
            statusText: "Too Many Requests",
            headers: { "retry-after": "120" },
            config,
            data: {},
          },
        ),
      );
    },
  });
  observeFplBackoff(client);
  await assert.rejects(client.get("http://fixture/first"));
  const second = axios.create({ adapter: client.defaults.adapter });
  observeFplBackoff(second);
  await assert.rejects(second.get("http://fixture/second"), /FPL is limiting/);
  assert.equal(attempts, 1);
  assert.ok(fplBackoffRemaining() > 100000);
});
