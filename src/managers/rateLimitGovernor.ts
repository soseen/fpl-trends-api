// Adaptive rate-limit governor for FPL API ingestion.
// Tracks recent responses and pauses on errors. Used by populateManagers
// so a single cron run stays polite and aborts cleanly on sustained failures.

import { delay } from "../utils.js";

export type GovernorConfig = {
  baseDelayMs: number;
  maxDelayMs: number;
  pauseOn429Ms: number;
  pauseOnTimeoutMs: number;
  abortAfterConsecutiveErrors: number;
};

export const DEFAULT_GOVERNOR_CONFIG: GovernorConfig = {
  baseDelayMs: 300,
  maxDelayMs: 2400,
  pauseOn429Ms: 5 * 60_000,
  pauseOnTimeoutMs: 2 * 60_000,
  abortAfterConsecutiveErrors: 3,
};

export class RateLimitGovernor {
  private currentDelay: number;
  private consecutiveErrors = 0;
  private successStreak = 0;
  private aborted = false;

  constructor(
    private readonly config: GovernorConfig = DEFAULT_GOVERNOR_CONFIG,
  ) {
    this.currentDelay = config.baseDelayMs;
  }

  get shouldAbort(): boolean {
    return this.aborted;
  }

  get interBatchDelayMs(): number {
    return this.currentDelay;
  }

  noteSuccess(): void {
    this.consecutiveErrors = 0;
    this.successStreak += 1;
    // Decay the inter-batch delay back toward baseline after a clean streak.
    if (
      this.successStreak >= 50 &&
      this.currentDelay > this.config.baseDelayMs
    ) {
      this.currentDelay = Math.max(
        this.config.baseDelayMs,
        Math.floor(this.currentDelay / 2),
      );
      this.successStreak = 0;
      console.info(
        `[governor] success streak — decaying delay to ${this.currentDelay}ms`,
      );
    }
  }

  async noteError(error: unknown): Promise<void> {
    const status = extractStatus(error);

    // 404 = the specific entry/event doesn't exist (manager deleted, banned,
    // or never existed at this entry_id). It's a *per-call* permanent
    // failure, NOT a signal that the API is unhappy with us. Treating it
    // like a transient error trips the consecutive-errors abort during
    // backfills of large strata that always have a few dead entries
    // sprinkled through. Treat 404 as a soft skip: don't count it toward
    // the consecutive-error budget, don't pause, just bubble up so the
    // caller can record the per-entry failure and move on.
    if (status === 404) {
      // Reset successStreak so a fresh streak after the 404 still has to
      // earn its delay-decay, but leave consecutiveErrors alone.
      this.successStreak = 0;
      return;
    }

    this.consecutiveErrors += 1;
    this.successStreak = 0;

    if (this.consecutiveErrors >= this.config.abortAfterConsecutiveErrors) {
      console.error(
        `[governor] ${this.consecutiveErrors} consecutive errors — aborting run`,
      );
      this.aborted = true;
      return;
    }

    const retryAfterMs = extractRetryAfterMs(error);

    if (status === 429 || status === 503) {
      const pause = Math.max(retryAfterMs, this.config.pauseOn429Ms);
      this.currentDelay = Math.min(
        this.currentDelay * 2,
        this.config.maxDelayMs,
      );
      console.warn(
        `[governor] ${status} — pausing ${Math.round(pause / 1000)}s, delay now ${this.currentDelay}ms`,
      );
      await delay(pause);
      return;
    }

    if (isTimeoutError(error)) {
      console.warn(
        `[governor] timeout — pausing ${Math.round(this.config.pauseOnTimeoutMs / 1000)}s`,
      );
      await delay(this.config.pauseOnTimeoutMs);
      return;
    }

    // Unknown error — short backoff, then continue.
    await delay(this.currentDelay * 2);
  }
}

const extractStatus = (error: unknown): number | undefined => {
  if (typeof error === "object" && error !== null && "response" in error) {
    const r = (error as { response?: { status?: number } }).response;
    return r?.status;
  }
  return undefined;
};

const extractRetryAfterMs = (error: unknown): number => {
  if (typeof error !== "object" || error === null || !("response" in error))
    return 0;
  const headers = (error as { response?: { headers?: Record<string, string> } })
    .response?.headers;
  const value = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return 0;
};

const isTimeoutError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: string }).code;
  return (
    code === "ECONNABORTED" || code === "ETIMEDOUT" || code === "ECONNRESET"
  );
};
