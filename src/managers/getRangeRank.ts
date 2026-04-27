import { prisma } from "../database/client.js";
import { fetchEntrySummary, fetchEntryHistory } from "./fetchManager.js";
import { netPointsForEvent } from "./activityFilter.js";

export type RangeRankResponse = {
  entry_id: number;
  overall_rank: number | null;
  range_rank: number | null;
  range_total: number;
  // Cumulative overall rank at the GW immediately before the range, and at
  // the last GW in the range. Used by the UI to show whether the range
  // improved or worsened the user's trajectory. `before` is null when the
  // range starts at GW 1 (no prior GW exists).
  overall_rank_before: number | null;
  overall_rank_after: number | null;
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

// Total managers each stratum is meant to cover. Used for sample-aware
// extrapolation: we scale within-sample counts up to the full stratum.
const STRATUM_TRUE_SIZE: Record<1 | 2 | 3, number> = {
  1: STRATUM_A_MAX,
  2: STRATUM_B_MAX - STRATUM_A_MAX,
  3: STRATUM_C_MAX - STRATUM_B_MAX,
};

// Overall-rank offset before each stratum. Adding the within-stratum rank
// to this gives an overall rank in the right band.
const STRATUM_OFFSET: Record<1 | 2 | 3, number> = {
  1: 0,
  2: STRATUM_A_MAX,
  3: STRATUM_B_MAX,
};

const STRATUM_UPPER: Record<1 | 2 | 3, number> = {
  1: STRATUM_A_MAX,
  2: STRATUM_B_MAX,
  3: STRATUM_C_MAX,
};

const pickStratum = (overallRank: number | null): 1 | 2 | 3 | null => {
  if (overallRank === null) return null;
  if (overallRank <= STRATUM_A_MAX) return 1;
  if (overallRank <= STRATUM_B_MAX) return 2;
  if (overallRank <= STRATUM_C_MAX) return 3;
  return null;
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

  const allEvents = history.current ?? [];
  const events = allEvents.filter(
    (ev) => ev.event >= startGw && ev.event <= endGw,
  );
  const rangeTotal = events.reduce((acc, ev) => acc + netPointsForEvent(ev), 0);

  const overallRankBefore =
    startGw > 1
      ? (allEvents.find((ev) => ev.event === startGw - 1)?.overall_rank ?? null)
      : null;
  const overallRankAfter =
    allEvents.find((ev) => ev.event === endGw)?.overall_rank ?? null;

  const stratum = pickStratum(summary.summary_overall_rank);
  const overallRank = summary.summary_overall_rank;

  // Out of stratified range (e.g. unranked or deep tail past 10.4M). No
  // calculable range rank; surface null so the UI can render "—" honestly.
  if (stratum === null) {
    return {
      entry_id: entryId,
      overall_rank: overallRank,
      range_rank: null,
      range_total: rangeTotal,
      overall_rank_before: overallRankBefore,
      overall_rank_after: overallRankAfter,
      start_gw: startGw,
      end_gw: endGw,
      stratum_used: null,
      confidence: "approximate",
      sample_size: 0,
    };
  }

  const sampleSize = await sampleSizeForStratum(stratum);

  if (sampleSize === 0) {
    return {
      entry_id: entryId,
      overall_rank: overallRank,
      range_rank: null,
      range_total: rangeTotal,
      overall_rank_before: overallRankBefore,
      overall_rank_after: overallRankAfter,
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

  // Sample-size-aware scaling: extrapolate the in-sample count up to the
  // full stratum. Static factors (1/5/50) baked in a fully-sampled stratum
  // assumption that holds only after weeks of cron runs; using the actual
  // sample makes the estimate vary correctly even with sparse data.
  const scaling = STRATUM_TRUE_SIZE[stratum] / sampleSize;
  const withinStratum = Math.max(1, Math.round(higher * scaling));
  const rangeRank = Math.min(
    STRATUM_UPPER[stratum],
    STRATUM_OFFSET[stratum] + withinStratum,
  );

  // Stratum 1 with a full census gives an exact within-stratum count; any
  // partial sample (or stratum 2/3) is an extrapolated estimate.
  const confidence =
    stratum === 1 && sampleSize >= STRATUM_TRUE_SIZE[1] ? "exact" : "estimated";

  return {
    entry_id: entryId,
    overall_rank: overallRank,
    range_rank: rangeRank,
    range_total: rangeTotal,
    overall_rank_before: overallRankBefore,
    overall_rank_after: overallRankAfter,
    start_gw: startGw,
    end_gw: endGw,
    stratum_used: stratum,
    confidence,
    sample_size: sampleSize,
  };
};
