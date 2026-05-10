import { prisma } from "../database/client.js";

// Shared helpers for computing the "transfer net points" metric over a
// gameweek range. Used by:
//   - getManagerTransfers (full per-pair view for the My Trends section)
//   - getManagerComparison (just the user's totals, alongside sample stats)
//
// The metric: for each transfer at GW t.gw within [startGw, endGw],
// sum the IN player's points and the OUT player's points from t.gw
// through endGw. The transfer's net contribution is in − out; the
// manager's total is the sum across all transfers.
//
// `history` is per-fixture (DGWs have two rows for the same round), so
// summing on `total_points` naturally accounts for DGW points without
// special casing.

// (player_id, round) → sum of total_points across that round's fixtures.
export type PointsByRound = Map<string, number>;

const roundKey = (playerId: number, round: number): string =>
  `${playerId}:${round}`;

// Bulk fetch points for every (player, round) the caller will need, then
// caller can pivot in JS. The query span is `[minGw..endGw]`; per-transfer
// summation re-windows that span via `sumPointsInWindow`.
export const fetchHistoryPointsByRound = async (
  playerIds: ReadonlyArray<number>,
  minGw: number,
  endGw: number,
): Promise<PointsByRound> => {
  if (playerIds.length === 0 || minGw > endGw) return new Map();
  const rows = await prisma.$queryRawUnsafe<
    Array<{ footballer_id: number; round: number; total_points: number }>
  >(
    `
    SELECT footballer_id, round, total_points
    FROM history
    WHERE footballer_id = ANY($1::int[])
      AND round BETWEEN $2 AND $3
    `,
    [...playerIds],
    minGw,
    endGw,
  );

  const perRound = new Map<string, number>();
  for (const r of rows) {
    const k = roundKey(r.footballer_id, r.round);
    perRound.set(k, (perRound.get(k) ?? 0) + r.total_points);
  }
  return perRound;
};

export const sumPointsInWindow = (
  perRound: PointsByRound,
  playerId: number,
  fromGw: number,
  endGw: number,
): number => {
  let total = 0;
  for (let gw = fromGw; gw <= endGw; gw += 1) {
    total += perRound.get(roundKey(playerId, gw)) ?? 0;
  }
  return total;
};

// `computeUserTransferNet` lives in getManagerTransfers.ts now (it shares
// the full ghost-filter / multiplier-aware / hits-subtracted logic with
// the public endpoint, so the comparison-table user value matches the
// My Trends Transfer Impact section's headline byte-for-byte).

// Sample-side aggregate: average net-points-per-transfer across managers
// in the given stratum partition. Reads from `stratum_range_xfer_avg`,
// the per-(stratum, start_gw, end_gw) precomputed table rebuilt by
// populateManagers (cron) and backfillStratumRangeXferAvg (OOB).
//
// Range queries collapse to one indexed lookup per stratum, summed across
// the requested strata. Replaces the per-request CTE that joined
// manager_transfers ⨝ history with a generate_series — that path was the
// dominant cost of /api/manager/:id/comparison (three calls in parallel,
// ~18 s combined on cold cache).
//
// `stratumFilter`:
//   "active"   → strata 1, 2, 3 summed
//   "stratum12"→ strata 1, 2 summed (top-100k comparator)
//   "stratum1" → stratum 1 only (top-10k comparator)
//
// Combined-stratum mean is computed as
//   avg = SUM(sum_per_manager_avg) / SUM(managers_with_xfers)
// — a weighted mean of per-stratum means, weighted by manager count. This
// matches the previous request-time semantics where the per-request query
// computed AVG(per-manager average) over all matching managers in one go.
//
// Unlike the previous path, the precompute uses the FULL ingested
// stratum-3 sample (no entry_id % 32 sub-sample). Sample mean is unbiased
// either way; the larger N tightens the confidence interval.
//
// `with_data`: count of stratum managers with has_transfer_history=true.
// `stratum_size`: total stratum population. Both are stored redundantly
// per row in the precomputed table (don't depend on the range), so a
// single SUM across the matching strata gives the combined values.
// `gateOnMinimumSample` in getManagerComparison uses these to gate the
// displayed value when coverage is too thin.
export type SampleTransferNet = {
  avg: number | null;
  with_data: number;
  with_transfers: number;
  stratum_size: number;
};

export const sampleAvgPtsPerTransfer = async (
  startGw: number,
  endGw: number,
  stratumFilter: "active" | "stratum1" | "stratum12",
): Promise<SampleTransferNet> => {
  const strata =
    stratumFilter === "stratum1"
      ? [1]
      : stratumFilter === "stratum12"
        ? [1, 2]
        : [1, 2, 3];

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      sum_per_manager_avg: number | null;
      managers_with_xfers: number | null;
      with_data: number | null;
      stratum_size: number | null;
    }>
  >(
    `
    SELECT
      SUM(sum_per_manager_avg)::float AS sum_per_manager_avg,
      SUM(managers_with_xfers)::int   AS managers_with_xfers,
      SUM(with_data)::int             AS with_data,
      SUM(stratum_size)::int          AS stratum_size
    FROM stratum_range_xfer_avg
    WHERE start_gw = $1 AND end_gw = $2 AND stratum = ANY($3::int[])
    `,
    startGw,
    endGw,
    strata,
  );

  const row = rows[0];
  const managers = row?.managers_with_xfers ?? 0;
  const sum = row?.sum_per_manager_avg ?? 0;
  return {
    // Null when no managers in the requested strata had transfers in range
    // (or when the row is missing — e.g. mid-rebuild, or end_gw beyond what
    // the cron has refreshed). UI renders as "—" rather than zero.
    avg: managers > 0 ? sum / managers : null,
    with_data: row?.with_data ?? 0,
    with_transfers: managers,
    stratum_size: row?.stratum_size ?? 0,
  };
};
