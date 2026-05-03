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
// in the given stratum partition. One SQL call against
// manager_transfers ⨝ manager_cumulative ⨝ history. Range-conditional on
// (start_gw, end_gw) — can't be precomputed because each transfer's
// points window depends on the query's end_gw.
//
// Per-manager net: SUM(in_pts) - SUM(out_pts) over their transfers in
// range, where in_pts / out_pts are the player's history points from
// the transfer's gw through end_gw. Per-manager average: net / count.
// Stratum average: AVG(per-manager average) across managers with at
// least one transfer in range.
//
// `stratumFilter` matches the convention in sampleStratumAggregates:
//   "active" → strata 1, 2, 3 with rejected_reason IS NULL (sample mean
//              for the broader cohort)
//   "stratum1" → stratum 1 only with rejected_reason IS NULL (top 10k
//                comparator)
//
// Returns null when no managers in the stratum have transfers in range.
// `coverage` is a 0..1 fraction of stratum managers that contributed at
// least one transfer to the average — gates display via gateOnCoverage.
export type SampleTransferNet = {
  avg: number | null;
  with_data: number;
  stratum_size: number;
};

export const sampleAvgPtsPerTransfer = async (
  startGw: number,
  endGw: number,
  stratumFilter: "active" | "stratum1",
): Promise<SampleTransferNet> => {
  const stratumClause =
    stratumFilter === "stratum1"
      ? `AND mc.stratum = 1`
      : `AND mc.stratum IN (1, 2, 3)`;

  // Outer subquery: per-manager net + count from manager_transfers ⨝ history.
  // We use scalar subqueries (CROSS JOIN LATERAL pattern was rejected as
  // overkill for the small cardinality involved — at most a few hundred
  // transfers per manager × stratum_size managers).
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      avg_pts_per_transfer: number | null;
      with_transfers_data: number;
      stratum_size: number;
    }>
  >(
    `
    WITH stratum_managers AS (
      SELECT DISTINCT mc.entry_id
      FROM manager_cumulative mc
      WHERE mc.rejected_reason IS NULL
        ${stratumClause}
        AND mc.gw BETWEEN $1 AND $2
    ),
    per_manager AS (
      SELECT
        mt.entry_id,
        SUM(
          COALESCE(
            (SELECT SUM(h.total_points)::int
               FROM history h
               WHERE h.footballer_id = mt.in_element
                 AND h.round BETWEEN mt.gw AND $2),
            0
          )
          -
          COALESCE(
            (SELECT SUM(h.total_points)::int
               FROM history h
               WHERE h.footballer_id = mt.out_element
                 AND h.round BETWEEN mt.gw AND $2),
            0
          )
        )::float AS net,
        COUNT(*)::int AS xfers
      FROM manager_transfers mt
      JOIN stratum_managers sm ON sm.entry_id = mt.entry_id
      WHERE mt.gw BETWEEN $1 AND $2
      GROUP BY mt.entry_id
    )
    SELECT
      AVG(per_manager.net / NULLIF(per_manager.xfers, 0))::float AS avg_pts_per_transfer,
      COUNT(*)::int AS with_transfers_data,
      (SELECT COUNT(*)::int FROM stratum_managers) AS stratum_size
    FROM per_manager
    WHERE per_manager.xfers > 0
    `,
    startGw,
    endGw,
  );

  const row = rows[0];
  return {
    avg: row?.avg_pts_per_transfer ?? null,
    with_data: row?.with_transfers_data ?? 0,
    stratum_size: row?.stratum_size ?? 0,
  };
};
