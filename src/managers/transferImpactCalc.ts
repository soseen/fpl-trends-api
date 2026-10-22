import { prisma } from "../database/client.js";
import { publishedRange } from "../analytics/store.js";

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

// Raw IN-minus-OUT comparison means are prepared in immutable benchmarks.
// Both user and cohort sides exclude chip transfers, lineups and hit costs;
// the detailed Transfer Impact section remains a counterfactual model.
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
  const { range } = await publishedRange(startGw, endGw);
  const side =
    stratumFilter === "stratum1"
      ? "top10k"
      : stratumFilter === "stratum12"
        ? "top100k"
        : "average";
  return { avg: range.transferMeans[side], ...range.transferCoverage[side] };
};
