import type { PlayerHistory, GameweekEvent } from "../types.js";

export type ManagerClass = "active" | "inactive" | "trolling";

const INACTIVITY_LOOKBACK_GWS = 8;
const SEASON_HIT_COST_LIMIT = 60; // total event_transfers_cost across the season
const PER_GW_HIT_COST_LIMIT = 20; // 5+ extra hits in a single GW = chaotic

/**
 * Classify a manager based on their /api/entry/{id}/history/ response.
 *
 * Pure function — easy to unit test against fixture JSON.
 *
 * `currentGw` is the latest finished gameweek. If the season hasn't reached
 * INACTIVITY_LOOKBACK_GWS yet, the inactivity check is skipped (we can't
 * fairly judge a manager as inactive in week 3).
 */
export const classifyManager = (
  history: PlayerHistory,
  currentGw: number,
): ManagerClass => {
  const events: GameweekEvent[] = history.current ?? [];

  if (isTrolling(events)) return "trolling";
  if (isInactive(events, currentGw)) return "inactive";
  return "active";
};

const isTrolling = (events: GameweekEvent[]): boolean => {
  if (events.length === 0) return false;

  let totalHitCost = 0;
  for (const ev of events) {
    if (ev.event_transfers_cost >= PER_GW_HIT_COST_LIMIT) return true;
    totalHitCost += ev.event_transfers_cost;
  }
  return totalHitCost > SEASON_HIT_COST_LIMIT;
};

const isInactive = (events: GameweekEvent[], currentGw: number): boolean => {
  if (currentGw < INACTIVITY_LOOKBACK_GWS) return false;

  const recent = events.filter(
    (ev) =>
      ev.event > currentGw - INACTIVITY_LOOKBACK_GWS && ev.event <= currentGw,
  );

  // If we don't have any data for the recent window the entry is unusual —
  // treat as inactive rather than insert noisy/empty data.
  if (recent.length === 0) return true;

  return recent.every((ev) => ev.event_transfers === 0);
};

/**
 * Compute net GW points the same way the live user calc does:
 *   net = points − event_transfers_cost
 * Used during ingestion; range queries sum these stored values.
 */
export const netPointsForEvent = (ev: GameweekEvent): number =>
  ev.points - ev.event_transfers_cost;
