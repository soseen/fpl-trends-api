import { fetchLiveManagerHistory } from "./liveManagerHistory.js";
import { prisma } from "../database/client.js";

import { netPointsForEvent } from "./activityFilter.js";
import { resolvePicks, captainPicksFromResolved } from "./resolvePicks.js";
import { rawTransferAverage } from "../analytics/model.js";
import { resolveTransfers } from "./resolveTransfers.js";
import {
  fetchHistoryPointsByRound,
  sampleAvgPtsPerTransfer,
} from "./transferImpactCalc.js";
import type { PlayerHistory } from "../types.js";

import { getComparisonCohorts } from "./comparisonCohorts.js";

export type ComparisonStat = {
  user: number | null;
  average: number | null;
  top100k_average: number | null;
  top10k_average: number | null;
};

export type ChipHalfStat = {
  average: number | null;
  top100k_average: number | null;
  top10k_average: number | null;
};

export type ChipUsageStat = {
  user: number;
  h1: ChipHalfStat | null;
  h2: ChipHalfStat | null;
};

export type CaptainSummary = {
  user_player_id: number | null;
  user_player_name: string | null;
  average_player_id: number | null;
  average_player_name: string | null;
  top100k_player_id: number | null;
  top100k_player_name: string | null;
  top10k_player_id: number | null;
  top10k_player_name: string | null;
};

export type ManagerComparisonResponse = {
  entry_id: number;
  start_gw: number;
  end_gw: number;
  total_points: ComparisonStat;
  transfers: ComparisonStat;
  // Chip stats: user is 0 or 1 (played within range or not). Average is the
  // fraction of FPL managers (0..1) who played that chip in the range.
  wildcards: ChipUsageStat;
  free_hits: ChipUsageStat;
  bench_boosts: ChipUsageStat;
  triple_captains: ChipUsageStat;
  hits: ComparisonStat;
  bench_points: ComparisonStat;
  // Sum of (captained_player_points × (multiplier − 1)) across the range.
  // Sample averages sum independently sampled per-GW captain results. Rank
  // strata are population-weighted so the larger elite samples do not bias
  // the overall-manager value.
  captain_bonus: ComparisonStat;
  // Average net points per transfer made in range. User value:
  // (sum of (in_player_points − out_player_points) over [transfer.gw, end_gw])
  // / number_of_transfers_in_range. Sample averages are per-manager averages
  // averaged across the stratum (managers with zero in-range transfers are
  // excluded from the sample mean — they have no defined per-transfer rate).
  // Range-conditional and backed by the comparison-cohort transfer read model.
  avg_pts_per_transfer: ComparisonStat;
  // Mean per-GW points (range total / GWs played). For sample averages this
  // is computed per-manager then averaged.
  avg_gw_score: ComparisonStat;
  // Most-captained player across the range — separate shape because the
  // value is a player name, not a numeric stat.
  most_captained: CaptainSummary;
  notes: {
    provisional: boolean;
    hits_average_partial: boolean;
    bench_average_partial: boolean;
    captain_average_partial: boolean;
    transfers_average_partial: boolean;
  };
};

const CHIP_NAME_WILDCARD = "wildcard";
const CHIP_NAME_FREEHIT = "freehit";
const CHIP_NAME_BBOOST = "bboost";
const CHIP_NAME_TRIPLE_CAPTAIN = "3xc";

// Look up player web_name for display. Returns null if footballer not found.
const footballerName = async (id: number | null): Promise<string | null> => {
  if (id === null) return null;
  const f = await prisma.footballers.findUnique({
    where: { id },
    select: { web_name: true },
  });
  return f?.web_name ?? null;
};

// Compute the user's captain bonus from a set of resolved captain picks
// joined to the footballers' history table. One round-trip — UNNEST of
// parallel arrays of (captain_element, gw) gives us the per-GW points
// for every captained player without N+1 lookups.
const userCaptainBonusFromPicks = async (
  captains: Array<{
    gw: number;
    captain_element: number;
    captain_multiplier: number;
  }>,
): Promise<number> => {
  if (captains.length === 0) return 0;
  const elements = captains.map((c) => c.captain_element);
  const gws = captains.map((c) => c.gw);
  const rows = await prisma.$queryRawUnsafe<
    Array<{ captain_element: number; gw: number; pts: number }>
  >(
    `
    SELECT pairs.captain_element, pairs.gw, COALESCE(SUM(h.total_points), 0)::int AS pts
    FROM unnest($1::int[], $2::int[]) AS pairs(captain_element, gw)
    LEFT JOIN history h
      ON h.footballer_id = pairs.captain_element AND h.round = pairs.gw
    GROUP BY pairs.captain_element, pairs.gw
    `,
    elements,
    gws,
  );
  const ptsByKey = new Map<string, number>();
  for (const r of rows) ptsByKey.set(`${r.captain_element}:${r.gw}`, r.pts);

  let bonus = 0;
  for (const c of captains) {
    const pts = ptsByKey.get(`${c.captain_element}:${c.gw}`) ?? 0;
    bonus += pts * Math.max(0, c.captain_multiplier - 1);
  }
  return bonus;
};

const gateOnMinimumSample = (
  value: number | null,
  withData: number,
  stratumFilter: "active" | "stratum1" | "stratum12",
): number | null => {
  if (value === null || withData < captainSampleMinimum(stratumFilter)) {
    return null;
  }
  return value;
};

const captainSampleMinimum = (
  stratumFilter: "active" | "stratum1" | "stratum12",
): number => {
  if (stratumFilter === "stratum1") return 250;
  if (stratumFilter === "stratum12") return 1_000;
  return 1_500;
};

export const getManagerComparison = async (
  entryId: number,
  startGw: number,
  endGw: number,
): Promise<ManagerComparisonResponse> => {
  const history = await fetchLiveManagerHistory(entryId);

  const eventsInRange = history.current.filter(
    (ev) => ev.event >= startGw && ev.event <= endGw,
  );

  // ---- User-side aggregates from the FPL history payload (one fetch).
  const userTotalPoints = eventsInRange.reduce(
    (acc, ev) => acc + netPointsForEvent(ev),
    0,
  );
  const userTransfers = eventsInRange.reduce(
    (acc, ev) => acc + ev.event_transfers,
    0,
  );
  const userHits = eventsInRange.reduce(
    (acc, ev) => acc + Math.floor(ev.event_transfers_cost / 4),
    0,
  );
  const userBench = eventsInRange.reduce(
    (acc, ev) => acc + ev.points_on_bench,
    0,
  );
  const userGwScore =
    eventsInRange.length > 0 ? userTotalPoints / eventsInRange.length : 0;

  const chipsPlayedInRange = (history.chips ?? []).filter(
    (c) => c.event >= startGw && c.event <= endGw,
  );
  const userWildcard = chipsPlayedInRange.filter(
    (c) => c.name === CHIP_NAME_WILDCARD,
  ).length;
  const userFreeHit = chipsPlayedInRange.filter(
    (c) => c.name === CHIP_NAME_FREEHIT,
  ).length;
  const userBenchBoost = chipsPlayedInRange.filter(
    (c) => c.name === CHIP_NAME_BBOOST,
  ).length;
  const userTripleCaptain = chipsPlayedInRange.filter(
    (c) => c.name === CHIP_NAME_TRIPLE_CAPTAIN,
  ).length;

  // Event availability and provisional status for the selected range.
  const events = await prisma.events.findMany({
    where: { id: { gte: startGw, lte: endGw } },
    select: {
      id: true,
      data_checked: true,
    },
  });
  const ingestedGws = events.map((e) => e.id).sort((a, b) => a - b);

  // Published comparison metrics and shared per-user source resolution.
  const [
    cohorts,
    activeXferAgg,
    top100kXferAgg,
    top10kXferAgg,
    userPicks,
    userXferNet,
  ] = await Promise.all([
    getComparisonCohorts(startGw, endGw),
    sampleAvgPtsPerTransfer(startGw, endGw, "active"),
    sampleAvgPtsPerTransfer(startGw, endGw, "stratum12"),
    sampleAvgPtsPerTransfer(startGw, endGw, "stratum1"),
    resolvePicks(entryId, ingestedGws),
    userRawTransferAverage(entryId, startGw, endGw, history),
  ]);
  const activeAgg = cohorts.average;
  const top100kAgg = cohorts.top100k;
  const top10kAgg = cohorts.top10k;

  const avgHits = activeAgg.avg_hits;
  const avgBench = activeAgg.avg_bench;
  const avgHitsTop10k = top10kAgg.avg_hits;
  const avgBenchTop10k = top10kAgg.avg_bench;
  const avgHitsTop100k = top100kAgg.avg_hits;
  const avgBenchTop100k = top100kAgg.avg_bench;

  // Coverage gates for the new transfers-per-manager metric. The "active"
  // pool drives the partial-data flag because it's the larger sample —
  // top-10k transfers data fills in faster (smaller stratum) so it's
  // gated separately but doesn't influence the response-level note.
  const avgPtsPerTransferActive = gateOnMinimumSample(
    activeXferAgg.avg,
    activeXferAgg.with_data,
    "active",
  );
  const avgPtsPerTransferTop100k = gateOnMinimumSample(
    top100kXferAgg.avg,
    top100kXferAgg.with_data,
    "stratum12",
  );
  const avgPtsPerTransferTop10k = gateOnMinimumSample(
    top10kXferAgg.avg,
    top10kXferAgg.with_data,
    "stratum1",
  );

  const userAvgPtsPerTransfer = userXferNet;

  // ---- User captain bonus + most captained, derived from the resolved
  // picks. Every is_captain row already carries the post-autosub
  // multiplier; filter to multiplier > 1 (captain doubled) and join
  // with `history` for the captain's GW points in one query.
  const userCaptains = captainPicksFromResolved(userPicks, ingestedGws);
  const userCaptainsForBonus = userCaptains.filter(
    (
      c,
    ): c is {
      gw: number;
      captain_element: number;
      captain_multiplier: number;
    } =>
      c.captain_element !== null &&
      c.captain_multiplier !== null &&
      c.captain_multiplier > 1,
  );
  const userCaptainBonus =
    await userCaptainBonusFromPicks(userCaptainsForBonus);

  const captainCounts = new Map<number, number>();
  for (const pick of userPicks.picks.filter((p) => p.is_captain)) {
    const c = { captain_element: pick.element_id };
    if (c.captain_element !== null) {
      captainCounts.set(
        c.captain_element,
        (captainCounts.get(c.captain_element) ?? 0) + 1,
      );
    }
  }
  let userMostCaptainedElement: number | null = null;
  let max = 0;
  for (const [el, count] of captainCounts.entries()) {
    if (count > max) {
      max = count;
      userMostCaptainedElement = el;
    }
  }

  const userMostName = await footballerName(userMostCaptainedElement);
  const [averageMostName, top100kMostName, top10kMostName] = await Promise.all([
    footballerName(cohorts.averageCaptain.player_id),
    footballerName(cohorts.top100kCaptain.player_id),
    footballerName(cohorts.top10kCaptain.player_id),
  ]);

  const hasH1 = startGw <= 19;
  const hasH2 = endGw > 19;
  const chipStat = (
    user: number,
    averageH1: number | null,
    averageH2: number | null,
    top100kH1: number | null,
    top100kH2: number | null,
    top10kH1: number | null,
    top10kH2: number | null,
  ): ChipUsageStat => ({
    user,
    h1: hasH1
      ? {
          average: averageH1,
          top100k_average: top100kH1,
          top10k_average: top10kH1,
        }
      : null,
    h2: hasH2
      ? {
          average: averageH2,
          top100k_average: top100kH2,
          top10k_average: top10kH2,
        }
      : null,
  });

  return {
    entry_id: entryId,
    start_gw: startGw,
    end_gw: endGw,
    total_points: {
      user: userTotalPoints,
      average: activeAgg.avg_total_points,
      top100k_average: top100kAgg.avg_total_points,
      top10k_average: top10kAgg.avg_total_points,
    },
    transfers: {
      user: userTransfers,
      // Prefer the per-manager average from the cumulative sample (real
      // distribution across managers) when coverage is sufficient; fall
      // back to the event-level rate otherwise.
      average: activeAgg.avg_transfers,
      top100k_average: top100kAgg.avg_transfers,
      top10k_average: top10kAgg.avg_transfers,
    },
    wildcards: chipStat(
      userWildcard,
      activeAgg.wildcards_h1_rate,
      activeAgg.wildcards_h2_rate,
      top100kAgg.wildcards_h1_rate,
      top100kAgg.wildcards_h2_rate,
      top10kAgg.wildcards_h1_rate,
      top10kAgg.wildcards_h2_rate,
    ),
    free_hits: chipStat(
      userFreeHit,
      activeAgg.free_hits_h1_rate,
      activeAgg.free_hits_h2_rate,
      top100kAgg.free_hits_h1_rate,
      top100kAgg.free_hits_h2_rate,
      top10kAgg.free_hits_h1_rate,
      top10kAgg.free_hits_h2_rate,
    ),
    bench_boosts: chipStat(
      userBenchBoost,
      activeAgg.bench_boosts_h1_rate,
      activeAgg.bench_boosts_h2_rate,
      top100kAgg.bench_boosts_h1_rate,
      top100kAgg.bench_boosts_h2_rate,
      top10kAgg.bench_boosts_h1_rate,
      top10kAgg.bench_boosts_h2_rate,
    ),
    triple_captains: chipStat(
      userTripleCaptain,
      activeAgg.triple_captains_h1_rate,
      activeAgg.triple_captains_h2_rate,
      top100kAgg.triple_captains_h1_rate,
      top100kAgg.triple_captains_h2_rate,
      top10kAgg.triple_captains_h1_rate,
      top10kAgg.triple_captains_h2_rate,
    ),
    hits: {
      user: userHits,
      average: avgHits,
      top100k_average: avgHitsTop100k,
      top10k_average: avgHitsTop10k,
    },
    bench_points: {
      user: userBench,
      average: avgBench,
      top100k_average: avgBenchTop100k,
      top10k_average: avgBenchTop10k,
    },
    captain_bonus: {
      user: userCaptainBonus,
      average: activeAgg.avg_captain_bonus,
      top100k_average: top100kAgg.avg_captain_bonus,
      top10k_average: top10kAgg.avg_captain_bonus,
    },
    avg_pts_per_transfer: {
      user: userAvgPtsPerTransfer,
      average: avgPtsPerTransferActive,
      top100k_average: avgPtsPerTransferTop100k,
      top10k_average: avgPtsPerTransferTop10k,
    },
    avg_gw_score: {
      user: userGwScore,
      average: activeAgg.avg_gw_score,
      top100k_average: top100kAgg.avg_gw_score,
      top10k_average: top10kAgg.avg_gw_score,
    },
    most_captained: {
      user_player_id: userMostCaptainedElement,
      user_player_name: userMostName,
      average_player_id: cohorts.averageCaptain.player_id,
      average_player_name: averageMostName,
      top100k_player_id: cohorts.top100kCaptain.player_id,
      top100k_player_name: top100kMostName,
      top10k_player_id: cohorts.top10kCaptain.player_id,
      top10k_player_name: top10kMostName,
    },
    notes: {
      provisional: events.some((event) => !event.data_checked),
      hits_average_partial:
        avgHits !== null && activeAgg.with_hits_data < activeAgg.sample_size,
      bench_average_partial:
        avgBench !== null && activeAgg.with_bench_data < activeAgg.sample_size,
      // Captain averages require a sufficient independently sampled cohort
      // in every GW. Also flag the section when the user's own picks or the
      // most-captained sample could not be resolved across the full range.
      captain_average_partial:
        userPicks.incomplete ||
        activeAgg.avg_captain_bonus === null ||
        !cohorts.averageCaptain.sample_complete,
      // Transfers-per-manager backfill is still trickling in via
      // backfillManagerTransfers / per-visit ingestTransfersForEntry; gate
      // partial when the active stratum's coverage is below the threshold
      // baked into gateOnCoverage. The flag mirrors hits/bench:
      // displayed-as-≈ on the frontend rather than null, since we still
      // have a meaningful sample.
      transfers_average_partial:
        avgPtsPerTransferActive !== null &&
        activeXferAgg.with_data < activeXferAgg.stratum_size,
    },
  };
};

async function userRawTransferAverage(
  entry: number,
  start: number,
  end: number,
  history: PlayerHistory,
): Promise<number | null> {
  const transfers = await resolveTransfers(entry);
  const rows = transfers.rows.filter((t) => t.gw >= start && t.gw <= end);
  const points = await fetchHistoryPointsByRound(
    [...new Set(rows.flatMap((t) => [t.in_element, t.out_element]))],
    start,
    end,
  );
  const chips = new Map(history.chips.map((c) => [c.event, c.name]));
  return rawTransferAverage(
    {
      transfersComplete: !transfers.incomplete,
      transfers: rows.map((t) => ({
        gw: t.gw,
        in: t.in_element,
        out: t.out_element,
      })),
      facts: history.current.map((f) => ({
        gw: f.event,
        points: f.points,
        rank: f.overall_rank,
        transfers: f.event_transfers,
        hits: f.event_transfers_cost,
        bench: f.points_on_bench,
        chip: chips.get(f.event) ?? null,
        captain: null,
      })),
    },
    points,
    start,
    end,
  );
}
