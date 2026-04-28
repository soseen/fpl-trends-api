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

const ALL_STRATA: ReadonlyArray<1 | 2 | 3> = [1, 2, 3];

const pickStratum = (overallRank: number | null): 1 | 2 | 3 | null => {
  if (overallRank === null) return null;
  if (overallRank <= STRATUM_A_MAX) return 1;
  if (overallRank <= STRATUM_B_MAX) return 2;
  if (overallRank <= STRATUM_C_MAX) return 3;
  return null;
};

// Counts active managers in a stratum whose summed range points >= threshold.
// `rejected_reason IS NULL` is implicit (non-active managers have no
// `manager_history` rows and so cannot satisfy the HAVING clause), but kept
// explicit for auditability.
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
      GROUP BY mh.entry_id
      HAVING SUM(mh.points) >= ${threshold}
    ) t
  `;
  return rows[0]?.higher ?? 0;
};

// Total probes in the stratum: active + inactive + trolling + fetch_failed.
// This is the correct denominator for Bernoulli-urn extrapolation. Filtering
// to `rejected_reason IS NULL` here would systematically overcount because
// the active subset scores higher on average than the full stratum.
const totalProbesInStratum = async (stratum: 1 | 2 | 3): Promise<number> => {
  return prisma.manager_summary.count({ where: { stratum } });
};

const rankedCountForGw = async (gw: number): Promise<number | null> => {
  const ev = await prisma.events.findUnique({
    where: { id: gw },
    select: { ranked_count: true },
  });
  return ev?.ranked_count ?? null;
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

  // Per-stratum probe counts. Used both for extrapolation scaling and to
  // report `sample_size` for the user's stratum. We always pull all three
  // — they're cheap counts on an indexed column.
  const [probes1, probes2, probes3] = (await Promise.all(
    ALL_STRATA.map((s) => totalProbesInStratum(s)),
  )) as [number, number, number];
  const probesByStratum: Record<1 | 2 | 3, number> = {
    1: probes1,
    2: probes2,
    3: probes3,
  };

  const userStratumProbes = stratum === null ? 0 : probesByStratum[stratum];

  // Boot state: no managers ingested yet at all. Surface null so the UI can
  // render "—" honestly rather than fabricate a rank.
  const totalProbesAll = probes1 + probes2 + probes3;
  if (totalProbesAll === 0) {
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

  // Sum extrapolated higher-scorer counts across all strata. Each stratum is
  // a Bernoulli urn: a random probe either scored >= rangeTotal in the range
  // or didn't (inactive/troll/fetch_failed probes count toward the
  // denominator but not the numerator — they have no `manager_history`).
  // This replaces the previous offset+within-stratum approach: strata 1 and
  // 2 are densely sampled (census + 1-in-5), so their contribution is
  // essentially direct measurement; stratum 3 still extrapolates ~1000x.
  let totalHigher = 0;
  for (const s of ALL_STRATA) {
    const probes = probesByStratum[s];
    if (probes === 0) continue;
    const higherInS = await countHigherInStratum(s, startGw, endGw, rangeTotal);
    totalHigher += Math.round((higherInS * STRATUM_TRUE_SIZE[s]) / probes);
  }

  // Sanity bound: the rank can't exceed how many managers were actually
  // ranked at the end of the range. Especially relevant for early-season
  // ranges (e.g. only ~5.7M had a rank after GW7).
  const rankedAtEnd = await rankedCountForGw(endGw);
  const cap = rankedAtEnd ?? Number.MAX_SAFE_INTEGER;
  const rangeRank = Math.max(1, Math.min(totalHigher + 1, cap));

  // "exact" only when the user is in stratum 1 and we have a full census of
  // it. Anything else is an extrapolated estimate. `approximate` is reserved
  // for the no-data boot state handled above.
  const confidence =
    stratum === 1 && probesByStratum[1] >= STRATUM_TRUE_SIZE[1]
      ? "exact"
      : "estimated";

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
    sample_size: userStratumProbes,
  };
};
