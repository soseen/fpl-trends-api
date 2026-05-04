import type { GameweekEvent } from "../types.js";

/**
 * Compute net GW points the same way the live user calc does:
 *   net = points − event_transfers_cost
 * Used during ingestion; range queries sum these stored values.
 *
 * The `activityFilter` name is historical — this module also used to
 * classify managers as active/inactive/trolling, but that logic was
 * removed when we dropped the `manager_summary.rejected_reason` column.
 * All sampled managers are now treated as valid stat contributors.
 */
export const netPointsForEvent = (ev: GameweekEvent): number =>
  ev.points - ev.event_transfers_cost;
