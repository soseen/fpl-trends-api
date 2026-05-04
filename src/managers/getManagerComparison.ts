import { prisma } from "../database/client.js";
import { fetchEntryHistory } from "./fetchManager.js";
import { netPointsForEvent } from "./activityFilter.js";
import { resolvePicks, captainPicksFromResolved } from "./resolvePicks.js";
import { sampleAvgPtsPerTransfer } from "./transferImpactCalc.js";
import { computeUserTransferNet } from "./getManagerTransfers.js";

type ChipPlay = { chip_name: string; num_played: number };

export type ComparisonStat = {
  user: number;
  average: number | null;
  top10k_average: number | null;
};

export type CaptainSummary = {
  user_player_id: number | null;
  user_player_name: string | null;
  average_player_id: number | null;
  average_player_name: string | null;
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
  wildcards: ComparisonStat;
  free_hits: ComparisonStat;
  bench_boosts: ComparisonStat;
  hits: ComparisonStat;
  bench_points: ComparisonStat;
  // Sum of (captained_player_points × (multiplier − 1)) across the range.
  // Ignores GWs where the captain ended up benched (multiplier 0). Top-10k
  // and overall averages come from the cumulative_captain_bonus delta over
  // the matching stratum partition — no per-row LATERAL join at request
  // time. Coverage depends on how much of the sample has picks ingested
  // (LEFT JOIN; missing picks contribute 0 — see populateManagers
  // rebuildCumulativeForEntry).
  captain_bonus: ComparisonStat;
  // Average net points per transfer made in range. User value:
  // (sum of (in_player_points − out_player_points) over [transfer.gw, end_gw])
  // / number_of_transfers_in_range. Sample averages are per-manager averages
  // averaged across the stratum (managers with zero in-range transfers are
  // excluded from the sample mean — they have no defined per-transfer rate).
  // Range-conditional, so this metric isn't backed by manager_cumulative;
  // sampleAvgPtsPerTransfer runs at request time over manager_transfers.
  avg_pts_per_transfer: ComparisonStat;
  // Mean per-GW points (range total / GWs played). For sample averages this
  // is computed per-manager then averaged.
  avg_gw_score: ComparisonStat;
  // Most-captained player across the range — separate shape because the
  // value is a player name, not a numeric stat.
  most_captained: CaptainSummary;
  notes: {
    hits_average_partial: boolean;
    bench_average_partial: boolean;
    captain_average_partial: boolean;
    transfers_average_partial: boolean;
  };
};

const CHIP_NAME_WILDCARD = "wildcard";
const CHIP_NAME_FREEHIT = "freehit";
const CHIP_NAME_BBOOST = "bboost";

const sumChipPlays = (
  chipPlays: ChipPlay[] | null | undefined,
  chipName: string,
): number => {
  if (!chipPlays) return 0;
  const entry = chipPlays.find((c) => c.chip_name === chipName);
  return entry?.num_played ?? 0;
};

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
    bonus += pts * (c.captain_multiplier - 1);
  }
  return bonus;
};

// Most-captained element in [startGw, endGw] under the given filter,
// served by the pre-aggregated stratum_captain_picks_gw table. The table
// is rebuilt at the end of every populateManagers run (see
// rebuildStratumCaptainPicks). Returns null if no captain rows in range.
//
// `stratumFilter`:
//   - "active" → all strata (1, 2, 3), full sample.
//   - "stratum1" → stratum 1 only.
const sampleMostCaptained = async (
  startGw: number,
  endGw: number,
  stratumFilter: "active" | "stratum1",
): Promise<number | null> => {
  const stratumClause =
    stratumFilter === "stratum1"
      ? `AND stratum = 1`
      : `AND stratum IN (1, 2, 3)`;
  const rows = await prisma.$queryRawUnsafe<
    Array<{ captain_element: number; picks: number }>
  >(
    `
    SELECT captain_element, SUM(picks)::int AS picks
    FROM stratum_captain_picks_gw
    WHERE gw BETWEEN $1 AND $2
      ${stratumClause}
    GROUP BY captain_element
    ORDER BY picks DESC
    LIMIT 1
    `,
    startGw,
    endGw,
  );
  return rows[0]?.captain_element ?? null;
};

// Per-stratum sample aggregates: averages of total_points, transfers,
// hits, bench, captain_bonus, gw_score; chip rates; coverage counts.
//
// Reads from `stratum_gw_running_stats`, the per-(stratum, gw) running
// totals rebuilt at the end of every populateManagers cron tick (see
// `rebuildStratumGwRunningStats`). Range queries collapse to two-row
// lookups: subtract the row at gw=startGw−1 from the row at gw=endGw,
// then divide by the sample size at gw=endGw for averages.
//
// Replaces the per-request DISTINCT ON over ~750k stratum-3 rows that
// was costing 15–25 s on cold cache. Read cost here is O(strata) — at
// most six rows touched per call, indexed lookups, sub-millisecond.
//
// `stratumFilter`:
//   - "active" → all strata (1, 2, 3) summed.
//   - "stratum1" → stratum 1 only (the top-10k comparator).
const sampleStratumAggregates = async (
  startGw: number,
  endGw: number,
  stratumFilter: "active" | "stratum1",
): Promise<{
  avg_total_points: number | null;
  avg_transfers: number | null;
  avg_hits: number | null;
  avg_bench: number | null;
  avg_captain_bonus: number | null;
  avg_gw_score: number | null;
  wildcards_rate: number | null;
  free_hits_rate: number | null;
  bench_boosts_rate: number | null;
  sample_size: number;
  with_hits_data: number;
  with_bench_data: number;
  with_transfers_data: number;
}> => {
  const strata = stratumFilter === "stratum1" ? [1] : [1, 2, 3];
  // Bind the IN-list as a Postgres int[] so the parameter count is
  // independent of stratum cardinality.
  const stratumArr = strata;

  // Two lookups, summed across the requested strata, for end_gw and
  // start_gw - 1 respectively. start row is null for ranges starting at
  // GW 1 (no prior row), and we COALESCE all of its running fields to 0.
  // sample_size for the range is sample_size at end_gw — managers active
  // at end_gw are the population the averages are normalised against.
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      sum_e_points: bigint | null;
      sum_e_transfers: bigint | null;
      sum_e_hits_cost: bigint | null;
      sum_e_bench: bigint | null;
      sum_e_captain_bonus: bigint | null;
      sum_e_gws_played: bigint | null;
      sum_s_points: bigint | null;
      sum_s_transfers: bigint | null;
      sum_s_hits_cost: bigint | null;
      sum_s_bench: bigint | null;
      sum_s_captain_bonus: bigint | null;
      sum_s_gws_played: bigint | null;
      e_sample_size: number | null;
      e_with_transfers: number | null;
      e_with_hits: number | null;
      e_with_bench: number | null;
      e_wildcards_h1: number | null;
      e_wildcards_h2: number | null;
      e_freehits_h1: number | null;
      e_freehits_h2: number | null;
      e_bboosts_h1: number | null;
      e_bboosts_h2: number | null;
      s_wildcards_h1: number | null;
      s_wildcards_h2: number | null;
      s_freehits_h1: number | null;
      s_freehits_h2: number | null;
      s_bboosts_h1: number | null;
      s_bboosts_h2: number | null;
    }>
  >(
    `
    WITH e AS (
      SELECT
        SUM(sum_cum_points)::bigint        AS sum_points,
        SUM(sum_cum_transfers)::bigint     AS sum_transfers,
        SUM(sum_cum_hits_cost)::bigint     AS sum_hits_cost,
        SUM(sum_cum_bench)::bigint         AS sum_bench,
        SUM(sum_cum_captain_bonus)::bigint AS sum_captain_bonus,
        SUM(sum_gws_played)::bigint        AS sum_gws_played,
        SUM(sample_size)::int              AS sample_size,
        SUM(count_with_transfers)::int     AS with_transfers,
        SUM(count_with_hits)::int          AS with_hits,
        SUM(count_with_bench)::int         AS with_bench,
        SUM(cum_wildcards_h1)::int         AS wildcards_h1,
        SUM(cum_wildcards_h2)::int         AS wildcards_h2,
        SUM(cum_freehits_h1)::int          AS freehits_h1,
        SUM(cum_freehits_h2)::int          AS freehits_h2,
        SUM(cum_bboosts_h1)::int           AS bboosts_h1,
        SUM(cum_bboosts_h2)::int           AS bboosts_h2
      FROM stratum_gw_running_stats
      WHERE gw = $2 AND stratum = ANY($3::int[])
    ),
    s AS (
      SELECT
        SUM(sum_cum_points)::bigint        AS sum_points,
        SUM(sum_cum_transfers)::bigint     AS sum_transfers,
        SUM(sum_cum_hits_cost)::bigint     AS sum_hits_cost,
        SUM(sum_cum_bench)::bigint         AS sum_bench,
        SUM(sum_cum_captain_bonus)::bigint AS sum_captain_bonus,
        SUM(sum_gws_played)::bigint        AS sum_gws_played,
        SUM(cum_wildcards_h1)::int         AS wildcards_h1,
        SUM(cum_wildcards_h2)::int         AS wildcards_h2,
        SUM(cum_freehits_h1)::int          AS freehits_h1,
        SUM(cum_freehits_h2)::int          AS freehits_h2,
        SUM(cum_bboosts_h1)::int           AS bboosts_h1,
        SUM(cum_bboosts_h2)::int           AS bboosts_h2
      FROM stratum_gw_running_stats
      WHERE gw = $1 - 1 AND stratum = ANY($3::int[])
    )
    SELECT
      e.sum_points                                AS sum_e_points,
      e.sum_transfers                             AS sum_e_transfers,
      e.sum_hits_cost                             AS sum_e_hits_cost,
      e.sum_bench                                 AS sum_e_bench,
      e.sum_captain_bonus                         AS sum_e_captain_bonus,
      e.sum_gws_played                            AS sum_e_gws_played,
      s.sum_points                                AS sum_s_points,
      s.sum_transfers                             AS sum_s_transfers,
      s.sum_hits_cost                             AS sum_s_hits_cost,
      s.sum_bench                                 AS sum_s_bench,
      s.sum_captain_bonus                         AS sum_s_captain_bonus,
      s.sum_gws_played                            AS sum_s_gws_played,
      e.sample_size                               AS e_sample_size,
      e.with_transfers                            AS e_with_transfers,
      e.with_hits                                 AS e_with_hits,
      e.with_bench                                AS e_with_bench,
      e.wildcards_h1                              AS e_wildcards_h1,
      e.wildcards_h2                              AS e_wildcards_h2,
      e.freehits_h1                               AS e_freehits_h1,
      e.freehits_h2                               AS e_freehits_h2,
      e.bboosts_h1                                AS e_bboosts_h1,
      e.bboosts_h2                                AS e_bboosts_h2,
      s.wildcards_h1                              AS s_wildcards_h1,
      s.wildcards_h2                              AS s_wildcards_h2,
      s.freehits_h1                               AS s_freehits_h1,
      s.freehits_h2                               AS s_freehits_h2,
      s.bboosts_h1                                AS s_bboosts_h1,
      s.bboosts_h2                                AS s_bboosts_h2
    FROM e CROSS JOIN s
    `,
    startGw,
    endGw,
    stratumArr,
  );

  const row = rows[0];
  if (!row) {
    return {
      avg_total_points: null,
      avg_transfers: null,
      avg_hits: null,
      avg_bench: null,
      avg_captain_bonus: null,
      avg_gw_score: null,
      wildcards_rate: null,
      free_hits_rate: null,
      bench_boosts_rate: null,
      sample_size: 0,
      with_hits_data: 0,
      with_bench_data: 0,
      with_transfers_data: 0,
    };
  }

  const sampleSize = row.e_sample_size ?? 0;
  if (sampleSize === 0) {
    return {
      avg_total_points: null,
      avg_transfers: null,
      avg_hits: null,
      avg_bench: null,
      avg_captain_bonus: null,
      avg_gw_score: null,
      wildcards_rate: null,
      free_hits_rate: null,
      bench_boosts_rate: null,
      sample_size: 0,
      with_hits_data: 0,
      with_bench_data: 0,
      with_transfers_data: 0,
    };
  }

  const num = (b: bigint | null | undefined): number => Number(b ?? 0n);
  const sumDelta = (
    e: bigint | null | undefined,
    s: bigint | null | undefined,
  ): number => num(e) - num(s);

  const dPoints = sumDelta(row.sum_e_points, row.sum_s_points);
  const dTransfers = sumDelta(row.sum_e_transfers, row.sum_s_transfers);
  const dHitsCost = sumDelta(row.sum_e_hits_cost, row.sum_s_hits_cost);
  const dBench = sumDelta(row.sum_e_bench, row.sum_s_bench);
  const dCaptainBonus = sumDelta(
    row.sum_e_captain_bonus,
    row.sum_s_captain_bonus,
  );
  const dGwsPlayed = sumDelta(row.sum_e_gws_played, row.sum_s_gws_played);

  // Chip "played-in-range" deltas, by half. A chip play is detected at the
  // earliest GW it appears in the cumulative; the per-half split lets a
  // range that crosses the GW20 boundary count both halves correctly.
  const dWildcards =
    Math.max(0, (row.e_wildcards_h1 ?? 0) - (row.s_wildcards_h1 ?? 0)) +
    Math.max(0, (row.e_wildcards_h2 ?? 0) - (row.s_wildcards_h2 ?? 0));
  const dFreehits =
    Math.max(0, (row.e_freehits_h1 ?? 0) - (row.s_freehits_h1 ?? 0)) +
    Math.max(0, (row.e_freehits_h2 ?? 0) - (row.s_freehits_h2 ?? 0));
  const dBboosts =
    Math.max(0, (row.e_bboosts_h1 ?? 0) - (row.s_bboosts_h1 ?? 0)) +
    Math.max(0, (row.e_bboosts_h2 ?? 0) - (row.s_bboosts_h2 ?? 0));

  return {
    avg_total_points: dPoints / sampleSize,
    avg_transfers: dTransfers / sampleSize,
    avg_hits: dHitsCost / 4.0 / sampleSize,
    avg_bench: dBench / sampleSize,
    avg_captain_bonus: dCaptainBonus / sampleSize,
    // avg_gw_score: average per-GW score in the range, weighted by sample size
    // (matches the previous semantics of (range_total / gws_played) averaged).
    avg_gw_score: dGwsPlayed > 0 ? dPoints / dGwsPlayed : null,
    wildcards_rate: dWildcards / sampleSize,
    free_hits_rate: dFreehits / sampleSize,
    bench_boosts_rate: dBboosts / sampleSize,
    sample_size: sampleSize,
    with_hits_data: row.e_with_hits ?? 0,
    with_bench_data: row.e_with_bench ?? 0,
    with_transfers_data: row.e_with_transfers ?? 0,
  };
};

const COVERAGE_THRESHOLD = 0.5;

const gateOnCoverage = (
  value: number | null,
  withData: number,
  sampleSize: number,
): number | null => {
  if (value === null || sampleSize === 0 || withData === 0) return null;
  const coverage = withData / sampleSize;
  return coverage >= COVERAGE_THRESHOLD ? value : null;
};

export const getManagerComparison = async (
  entryId: number,
  startGw: number,
  endGw: number,
): Promise<ManagerComparisonResponse> => {
  const history = await fetchEntryHistory(entryId);

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
  const userWildcard = chipsPlayedInRange.some(
    (c) => c.name === CHIP_NAME_WILDCARD,
  )
    ? 1
    : 0;
  const userFreeHit = chipsPlayedInRange.some(
    (c) => c.name === CHIP_NAME_FREEHIT,
  )
    ? 1
    : 0;
  const userBenchBoost = chipsPlayedInRange.some(
    (c) => c.name === CHIP_NAME_BBOOST,
  )
    ? 1
    : 0;

  // ---- Per-event aggregates from our DB (whole-population averages from
  // FPL's own per-GW counts; orthogonal to the sampled stratum stats).
  const events = await prisma.events.findMany({
    where: { id: { gte: startGw, lte: endGw }, finished: true },
    select: {
      id: true,
      average_entry_score: true,
      transfers_made: true,
      ranked_count: true,
      chip_plays: true,
    },
  });
  const finishedGws = events.map((e) => e.id).sort((a, b) => a - b);

  let avgTotalPoints = 0;
  let avgTransfersTotal = 0;
  let avgWildcardRate = 0;
  let avgFreeHitRate = 0;
  let avgBenchBoostRate = 0;

  for (const ev of events) {
    avgTotalPoints += ev.average_entry_score;
    if (ev.ranked_count > 0) {
      avgTransfersTotal += ev.transfers_made / ev.ranked_count;
      const cp = ev.chip_plays as ChipPlay[] | null;
      avgWildcardRate += sumChipPlays(cp, CHIP_NAME_WILDCARD) / ev.ranked_count;
      avgFreeHitRate += sumChipPlays(cp, CHIP_NAME_FREEHIT) / ev.ranked_count;
      avgBenchBoostRate += sumChipPlays(cp, CHIP_NAME_BBOOST) / ev.ranked_count;
    }
  }

  // ---- Sample-side per-stratum aggregates (active + top-10k) and most
  // captained, plus user picks resolution and user transfer net. All in
  // parallel — sample queries run on indexed cumulative tables (sub-second),
  // most-captained hits the tiny stratum_captain_picks_gw table (ms),
  // resolvePicks dedups the FPL picks fetch with team-impact when both
  // endpoints fire simultaneously from the frontend, and
  // computeUserTransferNet shares its FPL fetch with the transfers
  // endpoint via the in-flight de-dup in resolveTransfers.
  const [
    activeAgg,
    top10kAgg,
    activeMost,
    top10kMost,
    userPicks,
    userXferNet,
    activeXferAgg,
    top10kXferAgg,
  ] = await Promise.all([
    sampleStratumAggregates(startGw, endGw, "active"),
    sampleStratumAggregates(startGw, endGw, "stratum1"),
    sampleMostCaptained(startGw, endGw, "active"),
    sampleMostCaptained(startGw, endGw, "stratum1"),
    resolvePicks(entryId, finishedGws),
    computeUserTransferNet(entryId, startGw, endGw),
    sampleAvgPtsPerTransfer(startGw, endGw, "active"),
    sampleAvgPtsPerTransfer(startGw, endGw, "stratum1"),
  ]);

  const avgHits = gateOnCoverage(
    activeAgg.avg_hits,
    activeAgg.with_hits_data,
    activeAgg.sample_size,
  );
  const avgBench = gateOnCoverage(
    activeAgg.avg_bench,
    activeAgg.with_bench_data,
    activeAgg.sample_size,
  );
  const avgTransfersFromHistory = gateOnCoverage(
    activeAgg.avg_transfers,
    activeAgg.with_transfers_data,
    activeAgg.sample_size,
  );

  const avgHitsTop10k = gateOnCoverage(
    top10kAgg.avg_hits,
    top10kAgg.with_hits_data,
    top10kAgg.sample_size,
  );
  const avgBenchTop10k = gateOnCoverage(
    top10kAgg.avg_bench,
    top10kAgg.with_bench_data,
    top10kAgg.sample_size,
  );

  // Coverage gates for the new transfers-per-manager metric. The "active"
  // pool drives the partial-data flag because it's the larger sample —
  // top-10k transfers data fills in faster (smaller stratum) so it's
  // gated separately but doesn't influence the response-level note.
  const avgPtsPerTransferActive = gateOnCoverage(
    activeXferAgg.avg,
    activeXferAgg.with_data,
    activeXferAgg.stratum_size,
  );
  const avgPtsPerTransferTop10k = gateOnCoverage(
    top10kXferAgg.avg,
    top10kXferAgg.with_data,
    top10kXferAgg.stratum_size,
  );

  const userAvgPtsPerTransfer =
    userXferNet.total_count > 0
      ? userXferNet.total_net / userXferNet.total_count
      : 0;

  // ---- User captain bonus + most captained, derived from the resolved
  // picks. Every is_captain row already carries the post-autosub
  // multiplier; filter to multiplier > 1 (captain doubled) and join
  // with `history` for the captain's GW points in one query.
  const userCaptains = captainPicksFromResolved(userPicks, finishedGws);
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
  for (const c of userCaptains) {
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

  const [userMostName, activeMostName, top10kMostName] = await Promise.all([
    footballerName(userMostCaptainedElement),
    footballerName(activeMost),
    footballerName(top10kMost),
  ]);

  return {
    entry_id: entryId,
    start_gw: startGw,
    end_gw: endGw,
    total_points: {
      user: userTotalPoints,
      average: avgTotalPoints,
      top10k_average: top10kAgg.avg_total_points,
    },
    transfers: {
      user: userTransfers,
      // Prefer the per-manager average from the cumulative sample (real
      // distribution across managers) when coverage is sufficient; fall
      // back to the event-level rate otherwise.
      average: avgTransfersFromHistory ?? avgTransfersTotal,
      top10k_average: top10kAgg.avg_transfers,
    },
    wildcards: {
      user: userWildcard,
      average: avgWildcardRate,
      top10k_average: top10kAgg.wildcards_rate,
    },
    free_hits: {
      user: userFreeHit,
      average: avgFreeHitRate,
      top10k_average: top10kAgg.free_hits_rate,
    },
    bench_boosts: {
      user: userBenchBoost,
      average: avgBenchBoostRate,
      top10k_average: top10kAgg.bench_boosts_rate,
    },
    hits: {
      user: userHits,
      average: avgHits,
      top10k_average: avgHitsTop10k,
    },
    bench_points: {
      user: userBench,
      average: avgBench,
      top10k_average: avgBenchTop10k,
    },
    captain_bonus: {
      user: userCaptainBonus,
      average: activeAgg.avg_captain_bonus,
      top10k_average: top10kAgg.avg_captain_bonus,
    },
    avg_pts_per_transfer: {
      user: userAvgPtsPerTransfer,
      average: avgPtsPerTransferActive,
      top10k_average: avgPtsPerTransferTop10k,
    },
    avg_gw_score: {
      user: userGwScore,
      average: activeAgg.avg_gw_score,
      top10k_average: top10kAgg.avg_gw_score,
    },
    most_captained: {
      user_player_id: userMostCaptainedElement,
      user_player_name: userMostName,
      average_player_id: activeMost,
      average_player_name: activeMostName,
      top10k_player_id: top10kMost,
      top10k_player_name: top10kMostName,
    },
    notes: {
      hits_average_partial:
        avgHits !== null && activeAgg.with_hits_data < activeAgg.sample_size,
      bench_average_partial:
        avgBench !== null && activeAgg.with_bench_data < activeAgg.sample_size,
      // Captain bonus accuracy in the new path is bounded by picks coverage
      // in the sample. cumulative_captain_bonus accumulates 0 for GWs
      // without picks ingested (LEFT JOIN), so the average converges as
      // backfillPicks fills in historical picks. Flagged as partial when
      // the user's own picks resolution wasn't complete (a stricter signal
      // than the previous sample-size heuristic — the user can see for
      // themselves that some of their own picks weren't fetched).
      captain_average_partial: userPicks.incomplete,
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
