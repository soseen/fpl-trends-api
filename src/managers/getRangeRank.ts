import { prisma } from "../database/client.js";
import { fetchEntrySummary, fetchEntryHistory } from "./fetchManager.js";
import { netPointsForEvent } from "./activityFilter.js";

export type RangeRankResponse = {
  entry_id: number;
  overall_rank: number | null;
  total_points: number | null;
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
// Stratum 3 upper bound is dynamic — derived per request from the latest
// finished gameweek's `ranked_count`. FPL's ranked count grows through the
// season as new managers join, and a static cap (e.g. 10.4M) becomes stale
// quickly. STRATUM_C_MAX_FALLBACK is used only when the events table has
// no finished GWs (boot state) and is set generously so users in the deep
// tail still get a calculated rank.
const STRATUM_A_MAX = 10_000;
const STRATUM_B_MAX = 100_000;
const STRATUM_C_MAX_FALLBACK = 15_000_000;

const ALL_STRATA: ReadonlyArray<1 | 2 | 3> = [1, 2, 3];

const stratumCMax = async (): Promise<number> => {
  const row = await prisma.events.aggregate({
    where: { finished: true },
    _max: { ranked_count: true },
  });
  return row._max.ranked_count ?? STRATUM_C_MAX_FALLBACK;
};

const pickStratum = (
  overallRank: number | null,
  cMax: number,
): 1 | 2 | 3 | null => {
  if (overallRank === null) return null;
  if (overallRank <= STRATUM_A_MAX) return 1;
  if (overallRank <= STRATUM_B_MAX) return 2;
  if (overallRank <= cMax) return 3;
  return null;
};

// Returns both `higher` (managers in the stratum whose summed range points
// >= threshold) and `probes_with_history` (managers in the stratum with at
// least one manager_history row in [startGw, endGw]) in a single SQL
// round-trip.
//
// Combining the two saves a full re-scan of `manager_history` per stratum:
// previously each request did 6 sequential aggregations (3 strata × 2
// queries), each scanning ~25M rows for stratum 3. With this single-CTE
// form we drop to 3 round-trips total and the CTE is materialised once.
//
// Includes inactive/trolling managers — they DO have `manager_history`
// rows (see populateManagers.ts where history is upserted regardless of
// classification). They're correctly part of the rank denominator: they
// were ranked at the relevant GW even if they later went idle. Only
// `fetch_failed` probes lack history and so naturally drop out of the
// numerator's HAVING clause.
const stratumCounts = async (
  stratum: 1 | 2 | 3,
  startGw: number,
  endGw: number,
  threshold: number,
): Promise<{ higher: number; probesWithHistory: number }> => {
  const rows = await prisma.$queryRaw<
    Array<{ higher: number; probes_with_history: number }>
  >`
    WITH manager_totals AS (
      SELECT mh.entry_id, SUM(mh.points)::int AS s
      FROM manager_history mh
      JOIN manager_summary ms ON ms.entry_id = mh.entry_id
      WHERE mh.gw BETWEEN ${startGw} AND ${endGw}
        AND ms.stratum = ${stratum}
      GROUP BY mh.entry_id
    )
    SELECT
      COUNT(*) FILTER (WHERE s >= ${threshold})::int AS higher,
      COUNT(*)::int AS probes_with_history
    FROM manager_totals
  `;
  const row = rows[0];
  return {
    higher: row?.higher ?? 0,
    probesWithHistory: row?.probes_with_history ?? 0,
  };
};

// Total probes in the stratum: active + inactive + trolling + fetch_failed.
// Used for the `sample_size` reported to the UI (cron progress indicator).
// NOT the right denominator for the Bernoulli-urn extrapolation — see
// `stratumCounts.probesWithHistory` for that.
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

  const cMax = await stratumCMax();
  const stratum = pickStratum(summary.summary_overall_rank, cMax);
  const overallRank = summary.summary_overall_rank;
  const totalPoints = summary.summary_overall_points ?? null;

  // Resolve the historical ranked_count for the end of the query range.
  // Stratum 3's true population at that point in time was
  // `rankedAtEnd - 100k`, NOT `cMax - 100k`. Using cMax (current
  // ranked_count, ~12.6M) for an early-GW query inflates the per-probe
  // weight because it includes ~7M late-joiners who couldn't have been
  // ranked at GW 4. Falling back to cMax keeps behaviour sensible if the
  // events table is missing a row for endGw (boot state, missed populate).
  const rankedAtEnd = await rankedCountForGw(endGw);
  const effectiveCMax = rankedAtEnd ?? cMax;
  const trueSize: Record<1 | 2 | 3, number> = {
    1: STRATUM_A_MAX,
    2: STRATUM_B_MAX - STRATUM_A_MAX,
    3: Math.max(effectiveCMax - STRATUM_B_MAX, 1),
  };

  // Total probes per stratum — only used to report `sample_size` to the UI
  // and to detect the boot state. The rank math uses
  // `probesWithHistoryByStratum` below, which excludes late joiners and
  // fetch_failed probes.
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
      total_points: totalPoints,
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

  // Sum extrapolated higher-scorer counts across all strata using the
  // Bernoulli-urn formula:
  //
  //     estimate_S = higherInS × trueSize[S] / probesWithHistory[S]
  //
  // Numerator: probes that satisfied SUM(history.points) >= threshold —
  // by definition only probes WITH manager_history rows for the range.
  // Denominator (the fix): probes ELIGIBLE to satisfy that condition,
  // i.e. those with at least one history row in the range. Excludes late
  // joiners and fetch_failed probes that never could have been the
  // numerator regardless of their true score.
  // trueSize: the true population that *was* ranked over the range. For
  // stratum 3 this scales with `rankedAtEnd`, not `cMax`, fixing the
  // ~25% over-estimate observed on early-range queries.
  // Run the three stratum aggregations in parallel — each is independent
  // and the dominant cost is the manager_history scan on stratum 3.
  // Without parallelism the 3 strata serialise to ~9–10s on the prod box.
  const stratumResults = await Promise.all(
    ALL_STRATA.map((s) => stratumCounts(s, startGw, endGw, rangeTotal)),
  );

  let totalHigher = 0;
  for (let i = 0; i < ALL_STRATA.length; i++) {
    const s = ALL_STRATA[i] as 1 | 2 | 3;
    const r = stratumResults[i];
    if (!r || r.probesWithHistory === 0) continue;
    totalHigher += Math.round((r.higher * trueSize[s]) / r.probesWithHistory);
  }

  // Sanity bound: the rank can't exceed how many managers were actually
  // ranked at the end of the range. Especially relevant for early-season
  // ranges (e.g. only ~5.7M had a rank after GW7).
  const cap = rankedAtEnd ?? Number.MAX_SAFE_INTEGER;
  const rangeRank = Math.max(1, Math.min(totalHigher + 1, cap));

  // "exact" only when the user is in stratum 1 and we have a full census of
  // it. Anything else is an extrapolated estimate. `approximate` is reserved
  // for the no-data boot state handled above.
  const confidence =
    stratum === 1 && probesByStratum[1] >= trueSize[1] ? "exact" : "estimated";

  return {
    entry_id: entryId,
    overall_rank: overallRank,
    total_points: totalPoints,
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
