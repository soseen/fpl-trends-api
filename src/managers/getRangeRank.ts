import { fetchEntrySummary, fetchEntryHistory } from "./fetchManager.js";
import { netPointsForEvent } from "./activityFilter.js";
import {
  estimateRangeRankFromBuckets,
  managerSampleFreshnessForEndGw,
  pickStratum as pickRankStratum,
  stratumCMax as currentStratumCMax,
  type ManagerSampleStatus,
} from "./rangeStats.js";

export type RangeRankResponse = {
  entry_id: number;
  overall_rank: number | null;
  total_points: number | null;
  // Sample-based estimate. Computed by the Bernoulli-urn extrapolation
  // against our manager_summary / manager_history sample. This is the
  // number the UI surfaces as the primary "GWs X–Y rank" — it's what
  // users want to compare against the (eventually-published) official
  // FPL rank. Null only on the boot state (no probes ingested yet).
  range_rank: number | null;
  // Official rank from FPL's history endpoint at the end of the range.
  // FPL stores `overall_rank` per finished GW, which IS the cumulative
  // rank for GW1-to-N — for any startGw=1 query this is the exact
  // ground truth our `range_rank` estimate is trying to match. We
  // surface it alongside `range_rank` so the UI can show "estimated
  // 928k vs official 800k" and the operator can eyeball estimator
  // quality at a glance. Null when startGw > 1 (no FPL-stored answer
  // for partial-range queries) or when the user wasn't ranked at endGw.
  range_rank_official: number | null;
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
  sample_status: ManagerSampleStatus;
  sample_finalized: boolean;
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

  const cMax = await currentStratumCMax();
  const stratum = pickRankStratum(summary.summary_overall_rank, cMax);
  const overallRank = summary.summary_overall_rank;
  const totalPoints = summary.summary_overall_points ?? null;

  // For any startGw=1 query, FPL's history endpoint already published
  // the cumulative overall rank at the end of `endGw`; that's the
  // ground truth our estimator is trying to match. We surface it as
  // `range_rank_official` so the UI can render it alongside our
  // sample-based estimate ("estimated 928k · official 800k"). For
  // partial ranges (startGw > 1) FPL has no stored answer, so the
  // field stays null and the UI just shows the estimate.
  const rangeRankOfficial = startGw === 1 ? overallRankAfter : null;

  // Resolve the historical ranked_count for the end of the query range.
  // Stratum 3's true population at that point in time was
  // `rankedAtEnd - 100k`, NOT `cMax - 100k`. Using cMax (current
  // ranked_count, ~12.6M) for an early-GW query inflates the per-probe
  // weight because it includes ~7M late-joiners who couldn't have been
  // ranked at GW 4. Falling back to cMax keeps behaviour sensible if the
  // events table is missing a row for endGw (boot state, missed populate).
  const [estimate, sampleFreshness] = await Promise.all([
    estimateRangeRankFromBuckets(startGw, endGw, rangeTotal),
    managerSampleFreshnessForEndGw(endGw),
  ]);
  const canUseSampleEstimate = sampleFreshness.status !== "stale";

  // The UI's accuracy meter only cares about the user's own stratum
  // probe count — three separate count() queries to feed it was wasteful.
  // For stratum-1 census detection we only need to know if S1 specifically
  // is full; that check happens inline below using the per-stratum result.
  const userStratumProbes =
    stratum === null || !canUseSampleEstimate
      ? 0
      : estimate.sampleSizeByStratum[stratum];
  const rangeRank = canUseSampleEstimate
    ? (estimate.rangeRank ?? rangeRankOfficial)
    : rangeRankOfficial;
  const confidence: "exact" | "estimated" | "approximate" =
    rangeRankOfficial !== null && !canUseSampleEstimate
      ? "exact"
      : estimate.rangeRank !== null && sampleFreshness.status === "final"
        ? "estimated"
        : rangeRankOfficial !== null
          ? "exact"
          : "approximate";

  // Boot state: no managers ingested in the user's stratum yet. Surface
  // null so the UI shows "—" rather than a fabricated rank from an empty
  // sample. (We only need to detect this for the user's stratum because
  // the slow path uses the user's stratum to gate confidence reporting.)
  if (userStratumProbes === 0) {
    return {
      entry_id: entryId,
      overall_rank: overallRank,
      total_points: totalPoints,
      range_rank: rangeRank,
      range_rank_official: rangeRankOfficial,
      range_total: rangeTotal,
      overall_rank_before: overallRankBefore,
      overall_rank_after: overallRankAfter,
      start_gw: startGw,
      end_gw: endGw,
      stratum_used: stratum,
      confidence,
      sample_size: 0,
      sample_status: sampleFreshness.status,
      sample_finalized: sampleFreshness.finalized,
    };
  }

  return {
    entry_id: entryId,
    overall_rank: overallRank,
    total_points: totalPoints,
    range_rank: rangeRank,
    range_rank_official: rangeRankOfficial,
    range_total: rangeTotal,
    overall_rank_before: overallRankBefore,
    overall_rank_after: overallRankAfter,
    start_gw: startGw,
    end_gw: endGw,
    stratum_used: stratum,
    confidence,
    sample_size: userStratumProbes,
    sample_status: sampleFreshness.status,
    sample_finalized: sampleFreshness.finalized,
  };
};
