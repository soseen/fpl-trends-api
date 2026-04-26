import { prisma } from "../database/client.js";
import { fetchEntrySummary, fetchEntryHistory } from "./fetchManager.js";
import { netPointsForEvent } from "./activityFilter.js";

export type RangeRankResponse = {
  entry_id: number;
  overall_rank: number | null;
  range_rank: number | null;
  range_total: number;
  start_gw: number;
  end_gw: number;
  stratum_used: 1 | 2 | 3 | null;
  confidence: "exact" | "estimated" | "approximate";
  sample_size: number;
};

// Stratum boundaries (upper bound of overall rank, inclusive).
const STRATUM_A_MAX = 10_000;
const STRATUM_B_MAX = 100_000;
const STRATUM_C_MAX = 10_400_000;

const STRATUM_SCALING: Record<1 | 2 | 3, number> = {
  1: 1,
  2: 5,
  3: 50,
};

const pickStratum = (overallRank: number | null): 1 | 2 | 3 | null => {
  if (overallRank === null) return null;
  if (overallRank <= STRATUM_A_MAX) return 1;
  if (overallRank <= STRATUM_B_MAX) return 2;
  if (overallRank <= STRATUM_C_MAX) return 3;
  return null;
};

const clampRank = (estimated: number, anchor: number): number => {
  const lower = Math.max(1, Math.floor(anchor * 0.3));
  const upper = Math.ceil(anchor * 3);
  return Math.max(lower, Math.min(upper, estimated));
};

const countHigherInStratum = async (
  stratum: 1 | 2 | 3,
  startGw: number,
  endGw: number,
  threshold: number,
): Promise<number> => {
  const rows = await prisma.$queryRaw<Array<{ higher: number }>>`
    SELECT COUNT(*)::int AS higher
    FROM (
      SELECT mh.entry_id, SUM(mh.points)::int AS s
      FROM manager_history mh
      JOIN manager_summary ms ON ms.entry_id = mh.entry_id
      WHERE mh.gw BETWEEN ${startGw} AND ${endGw}
        AND ms.stratum = ${stratum}
        AND ms.rejected_reason IS NULL
      GROUP BY mh.entry_id
      HAVING SUM(mh.points) >= ${threshold}
    ) t
  `;
  return rows[0]?.higher ?? 0;
};

const sampleSizeForStratum = async (stratum: 1 | 2 | 3): Promise<number> => {
  const result = await prisma.manager_summary.count({
    where: { stratum, rejected_reason: null },
  });
  return result;
};

export const getRangeRank = async (
  entryId: number,
  startGw: number,
  endGw: number,
): Promise<RangeRankResponse> => {
  const [summary, history] = await Promise.all([
    fetchEntrySummary(entryId),
    fetchEntryHistory(entryId),
  ]);

  const events = (history.current ?? []).filter(
    (ev) => ev.event >= startGw && ev.event <= endGw,
  );
  const rangeTotal = events.reduce((acc, ev) => acc + netPointsForEvent(ev), 0);

  const stratum = pickStratum(summary.summary_overall_rank);
  const overallRank = summary.summary_overall_rank;

  // No usable stratum (e.g. inactive tail). Return overall as approximation.
  if (stratum === null || overallRank === null) {
    return {
      entry_id: entryId,
      overall_rank: overallRank,
      range_rank: overallRank,
      range_total: rangeTotal,
      start_gw: startGw,
      end_gw: endGw,
      stratum_used: null,
      confidence: "approximate",
      sample_size: 0,
    };
  }

  const sampleSize = await sampleSizeForStratum(stratum);

  // No data in this stratum yet (e.g. cron hasn't reached stratum B/C).
  // Fall back to overall rank as the best available estimate.
  if (sampleSize === 0) {
    return {
      entry_id: entryId,
      overall_rank: overallRank,
      range_rank: overallRank,
      range_total: rangeTotal,
      start_gw: startGw,
      end_gw: endGw,
      stratum_used: stratum,
      confidence: "approximate",
      sample_size: 0,
    };
  }

  const higher = await countHigherInStratum(
    stratum,
    startGw,
    endGw,
    rangeTotal,
  );
  const scaled = higher * STRATUM_SCALING[stratum];

  // Stratum A is a full census of the top 10k, so for users in stratum A
  // the count is exact (no scaling factor variance). Outside stratum A we
  // anchor with overall rank to bound miscalls while the sample is sparse.
  const rangeRank =
    stratum === 1
      ? Math.max(1, scaled)
      : clampRank(Math.max(1, scaled), overallRank);

  return {
    entry_id: entryId,
    overall_rank: overallRank,
    range_rank: rangeRank,
    range_total: rangeTotal,
    start_gw: startGw,
    end_gw: endGw,
    stratum_used: stratum,
    confidence: stratum === 1 ? "exact" : "estimated",
    sample_size: sampleSize,
  };
};
