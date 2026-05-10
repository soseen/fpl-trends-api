import { prisma } from "../database/client.js";
import { fetchEntryHistory } from "./fetchManager.js";
import { netPointsForEvent } from "./activityFilter.js";
import { resolvePicks, captainPicksFromResolved } from "./resolvePicks.js";
import { computeUserTransferNet } from "./getManagerTransfers.js";
import { sampleAvgPtsPerTransfer } from "./transferImpactCalc.js";

type ChipPlay = { chip_name: string; num_played: number };

export type ComparisonStat = {
  user: number;
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

const COVERAGE_THRESHOLD = 0.5;

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
  stratumFilter: "active" | "stratum1" | "stratum12",
): Promise<{
  avg_total_points: number | null;
  avg_transfers: number | null;
  avg_hits: number | null;
  avg_bench: number | null;
  avg_captain_bonus: number | null;
  avg_gw_score: number | null;
  wildcards_rate: number | null;
  wildcards_h1_rate: number | null;
  wildcards_h2_rate: number | null;
  free_hits_rate: number | null;
  free_hits_h1_rate: number | null;
  free_hits_h2_rate: number | null;
  bench_boosts_rate: number | null;
  bench_boosts_h1_rate: number | null;
  bench_boosts_h2_rate: number | null;
  sample_size: number;
  with_hits_data: number;
  with_bench_data: number;
  with_transfers_data: number;
  with_chips_data: number;
}> => {
  const strata =
    stratumFilter === "stratum1"
      ? [1]
      : stratumFilter === "stratum12"
        ? [1, 2]
        : [1, 2, 3];
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
      e_with_chips: number | null;
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
        SUM(count_with_chips)::int         AS with_chips,
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
      e.with_chips                                AS e_with_chips,
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
      wildcards_h1_rate: null,
      wildcards_h2_rate: null,
      free_hits_rate: null,
      free_hits_h1_rate: null,
      free_hits_h2_rate: null,
      bench_boosts_rate: null,
      bench_boosts_h1_rate: null,
      bench_boosts_h2_rate: null,
      sample_size: 0,
      with_hits_data: 0,
      with_bench_data: 0,
      with_transfers_data: 0,
      with_chips_data: 0,
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
      wildcards_h1_rate: null,
      wildcards_h2_rate: null,
      free_hits_rate: null,
      free_hits_h1_rate: null,
      free_hits_h2_rate: null,
      bench_boosts_rate: null,
      bench_boosts_h1_rate: null,
      bench_boosts_h2_rate: null,
      sample_size: 0,
      with_hits_data: 0,
      with_bench_data: 0,
      with_transfers_data: 0,
      with_chips_data: 0,
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
  const dWildcardsH1 = Math.max(
    0,
    (row.e_wildcards_h1 ?? 0) - (row.s_wildcards_h1 ?? 0),
  );
  const dWildcardsH2 = Math.max(
    0,
    (row.e_wildcards_h2 ?? 0) - (row.s_wildcards_h2 ?? 0),
  );
  const dFreehitsH1 = Math.max(
    0,
    (row.e_freehits_h1 ?? 0) - (row.s_freehits_h1 ?? 0),
  );
  const dFreehitsH2 = Math.max(
    0,
    (row.e_freehits_h2 ?? 0) - (row.s_freehits_h2 ?? 0),
  );
  const dBboostsH1 = Math.max(
    0,
    (row.e_bboosts_h1 ?? 0) - (row.s_bboosts_h1 ?? 0),
  );
  const dBboostsH2 = Math.max(
    0,
    (row.e_bboosts_h2 ?? 0) - (row.s_bboosts_h2 ?? 0),
  );
  const hasH1 = startGw <= 19;
  const hasH2 = endGw > 19;
  const chipSampleSize = row.e_with_chips ?? 0;
  const chipCoverage = sampleSize > 0 ? chipSampleSize / sampleSize : 0;
  const chipCoverageOk =
    chipSampleSize >= captainSampleMinimum(stratumFilter) &&
    chipCoverage >= COVERAGE_THRESHOLD;
  const chipRate = (played: number): number | null =>
    chipCoverageOk ? played / chipSampleSize : null;

  return {
    avg_total_points: dPoints / sampleSize,
    avg_transfers: dTransfers / sampleSize,
    avg_hits: dHitsCost / 4.0 / sampleSize,
    avg_bench: dBench / sampleSize,
    avg_captain_bonus: dCaptainBonus / sampleSize,
    // avg_gw_score: average per-GW score in the range, weighted by sample size
    // (matches the previous semantics of (range_total / gws_played) averaged).
    avg_gw_score: dGwsPlayed > 0 ? dPoints / dGwsPlayed : null,
    wildcards_rate: chipRate(dWildcardsH1 + dWildcardsH2),
    wildcards_h1_rate: hasH1 ? chipRate(dWildcardsH1) : null,
    wildcards_h2_rate: hasH2 ? chipRate(dWildcardsH2) : null,
    free_hits_rate: chipRate(dFreehitsH1 + dFreehitsH2),
    free_hits_h1_rate: hasH1 ? chipRate(dFreehitsH1) : null,
    free_hits_h2_rate: hasH2 ? chipRate(dFreehitsH2) : null,
    bench_boosts_rate: chipRate(dBboostsH1 + dBboostsH2),
    bench_boosts_h1_rate: hasH1 ? chipRate(dBboostsH1) : null,
    bench_boosts_h2_rate: hasH2 ? chipRate(dBboostsH2) : null,
    sample_size: sampleSize,
    with_hits_data: row.e_with_hits ?? 0,
    with_bench_data: row.e_with_bench ?? 0,
    with_transfers_data: row.e_with_transfers ?? 0,
    with_chips_data: chipSampleSize,
  };
};

const gateOnCoverage = (
  value: number | null,
  withData: number,
  sampleSize: number,
): number | null => {
  if (value === null || sampleSize === 0 || withData === 0) return null;
  const coverage = withData / sampleSize;
  return coverage >= COVERAGE_THRESHOLD ? value : null;
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

// Per-stratum sample aggregates for captain stats. Two precomputed reads,
// no per-request LATERAL joins:
//
// 1. avg_bonus — average captain bonus across managers with FULL picks
//    coverage in [startGw..endGw]. Reads cumulative_captain_bonus and
//    picks_count_cum from manager_cumulative; range delta of
//    picks_count_cum equals expectedGws iff the manager has a picks row
//    at every GW in the range. Same accuracy gate as the previous slow
//    path (which ran COUNT(DISTINCT mp.gw) = expectedGws over
//    manager_picks ⨝ history with a LATERAL captain-points subquery).
//    Both numbers monotonically converge as backfillPicks fills history.
//
// 2. most_captained — sum of pick counts across stratum_captain_picks_gw
//    in the range, take argmax. Tiny precomputed table (~17k rows total),
//    rebuilt at the end of each populateManagers run. Trade-off vs. the
//    previous "complete-coverage-only most-captained": partial-coverage
//    managers contribute their captain choices for ingested GWs, so a
//    minority of partially-ingested managers can shift the argmax. In
//    practice the most-captained over a range is a high-popularity
//    player and this drift is rare; the captain_average_partial flag
//    surfaced in the response notes lets the UI hedge the label when
//    coverage is below threshold.
const sampleCaptainAggregate = async (
  startGw: number,
  endGw: number,
  stratumFilter: "active" | "stratum1" | "stratum12",
): Promise<{
  avg_bonus: number | null;
  most_captained_id: number | null;
  most_captained_name: string | null;
  complete_managers: number;
}> => {
  const strata =
    stratumFilter === "stratum1"
      ? [1]
      : stratumFilter === "stratum12"
        ? [1, 2]
        : [1, 2, 3];
  const expectedGws = endGw - startGw + 1;
  const minimum = captainSampleMinimum(stratumFilter);

  const [bonusRows, mostRows] = await Promise.all([
    // Two anchored lookups (gw=endGw and gw=startGw-1) joined by
    // entry_id, filtered to managers whose picks_count_cum delta equals
    // expectedGws (full coverage in the range). Range captain bonus per
    // manager = cumulative_captain_bonus[end] − cumulative_captain_bonus[start-1].
    // start row is null for ranges starting at GW 1 — COALESCE to 0.
    prisma.$queryRawUnsafe<
      Array<{ avg_bonus: number | null; complete_managers: number }>
    >(
      `
      WITH e AS (
        SELECT entry_id, cumulative_captain_bonus, picks_count_cum
        FROM manager_cumulative
        WHERE gw = $2 AND stratum = ANY($3::int[])
      ),
      s AS (
        SELECT entry_id, cumulative_captain_bonus, picks_count_cum
        FROM manager_cumulative
        WHERE gw = $1 - 1 AND stratum = ANY($3::int[])
      )
      SELECT
        AVG(
          e.cumulative_captain_bonus
            - COALESCE(s.cumulative_captain_bonus, 0)
        )::float AS avg_bonus,
        COUNT(*)::int AS complete_managers
      FROM e
      LEFT JOIN s USING (entry_id)
      WHERE (e.picks_count_cum - COALESCE(s.picks_count_cum, 0)) = $4
      `,
      startGw,
      endGw,
      strata,
      expectedGws,
    ),
    // Most-captained over the range from the precomputed pick-counts
    // table. Filters captain_multiplier >= 2 to exclude rows where the
    // intended captain was benched (multiplier 0) and the vice took
    // over for the actual bonus.
    prisma.$queryRawUnsafe<Array<{ captain_element: number; picks: number }>>(
      `
      SELECT captain_element, SUM(picks)::int AS picks
      FROM stratum_captain_picks_gw
      WHERE stratum = ANY($3::int[])
        AND gw BETWEEN $1 AND $2
        AND captain_multiplier >= 2
      GROUP BY captain_element
      ORDER BY picks DESC
      LIMIT 1
      `,
      startGw,
      endGw,
      strata,
    ),
  ]);

  const bonusRow = bonusRows[0];
  const completeManagers = bonusRow?.complete_managers ?? 0;
  if (completeManagers < minimum) {
    return {
      avg_bonus: null,
      most_captained_id: null,
      most_captained_name: null,
      complete_managers: completeManagers,
    };
  }

  const mostId = mostRows[0]?.captain_element ?? null;
  return {
    avg_bonus: bonusRow?.avg_bonus ?? null,
    most_captained_id: mostId,
    most_captained_name: await footballerName(mostId),
    complete_managers: completeManagers,
  };
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
  const userWildcard = chipsPlayedInRange.filter(
    (c) => c.name === CHIP_NAME_WILDCARD,
  ).length;
  const userFreeHit = chipsPlayedInRange.filter(
    (c) => c.name === CHIP_NAME_FREEHIT,
  ).length;
  const userBenchBoost = chipsPlayedInRange.filter(
    (c) => c.name === CHIP_NAME_BBOOST,
  ).length;

  // ---- Per-event aggregates from our DB (whole-population averages from
  // FPL's own per-GW counts; orthogonal to the sampled stratum stats).
  const events = await prisma.events.findMany({
    where: { id: { gte: startGw, lte: endGw } },
    select: {
      id: true,
      average_entry_score: true,
      transfers_made: true,
      ranked_count: true,
      chip_plays: true,
    },
  });
  const ingestedGws = events.map((e) => e.id).sort((a, b) => a - b);

  let avgTotalPoints = 0;
  let avgTransfersTotal = 0;
  let avgWildcardH1Rate = 0;
  let avgWildcardH2Rate = 0;
  let avgFreeHitH1Rate = 0;
  let avgFreeHitH2Rate = 0;
  let avgBenchBoostH1Rate = 0;
  let avgBenchBoostH2Rate = 0;

  for (const ev of events) {
    avgTotalPoints += ev.average_entry_score;
    if (ev.ranked_count > 0) {
      avgTransfersTotal += ev.transfers_made / ev.ranked_count;
      const cp = ev.chip_plays as ChipPlay[] | null;
      const isH1 = ev.id <= 19;
      const wcRate = sumChipPlays(cp, CHIP_NAME_WILDCARD) / ev.ranked_count;
      const fhRate = sumChipPlays(cp, CHIP_NAME_FREEHIT) / ev.ranked_count;
      const bbRate = sumChipPlays(cp, CHIP_NAME_BBOOST) / ev.ranked_count;
      if (isH1) {
        avgWildcardH1Rate += wcRate;
        avgFreeHitH1Rate += fhRate;
        avgBenchBoostH1Rate += bbRate;
      } else {
        avgWildcardH2Rate += wcRate;
        avgFreeHitH2Rate += fhRate;
        avgBenchBoostH2Rate += bbRate;
      }
    }
  }

  // ---- Sample-side per-stratum aggregates, plus user picks resolution and
  // user transfer net. All in parallel: sample queries run on indexed
  // cumulative/read-model tables, resolvePicks dedups the FPL picks fetch with
  // team-impact, and computeUserTransferNet shares its FPL fetch with the
  // transfers endpoint via the in-flight de-dup in resolveTransfers.
  const [
    activeAgg,
    top100kAgg,
    top10kAgg,
    activeCaptainAgg,
    top100kCaptainAgg,
    top10kCaptainAgg,
    activeXferAgg,
    top100kXferAgg,
    top10kXferAgg,
    userPicks,
    userXferNet,
  ] = await Promise.all([
    sampleStratumAggregates(startGw, endGw, "active"),
    sampleStratumAggregates(startGw, endGw, "stratum12"),
    sampleStratumAggregates(startGw, endGw, "stratum1"),
    sampleCaptainAggregate(startGw, endGw, "active"),
    sampleCaptainAggregate(startGw, endGw, "stratum12"),
    sampleCaptainAggregate(startGw, endGw, "stratum1"),
    sampleAvgPtsPerTransfer(startGw, endGw, "active"),
    sampleAvgPtsPerTransfer(startGw, endGw, "stratum12"),
    sampleAvgPtsPerTransfer(startGw, endGw, "stratum1"),
    resolvePicks(entryId, ingestedGws),
    computeUserTransferNet(entryId, startGw, endGw),
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
  const avgHitsTop100k = gateOnCoverage(
    top100kAgg.avg_hits,
    top100kAgg.with_hits_data,
    top100kAgg.sample_size,
  );
  const avgBenchTop100k = gateOnCoverage(
    top100kAgg.avg_bench,
    top100kAgg.with_bench_data,
    top100kAgg.sample_size,
  );

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

  const userAvgPtsPerTransfer =
    userXferNet.total_count > 0
      ? userXferNet.total_net / userXferNet.total_count
      : 0;

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

  const userMostName = await footballerName(userMostCaptainedElement);

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
      average: avgTotalPoints,
      top100k_average: top100kAgg.avg_total_points,
      top10k_average: top10kAgg.avg_total_points,
    },
    transfers: {
      user: userTransfers,
      // Prefer the per-manager average from the cumulative sample (real
      // distribution across managers) when coverage is sufficient; fall
      // back to the event-level rate otherwise.
      average: avgTransfersTotal,
      top100k_average: top100kAgg.avg_transfers,
      top10k_average: top10kAgg.avg_transfers,
    },
    wildcards: chipStat(
      userWildcard,
      avgWildcardH1Rate,
      avgWildcardH2Rate,
      top100kAgg.wildcards_h1_rate,
      top100kAgg.wildcards_h2_rate,
      top10kAgg.wildcards_h1_rate,
      top10kAgg.wildcards_h2_rate,
    ),
    free_hits: chipStat(
      userFreeHit,
      avgFreeHitH1Rate,
      avgFreeHitH2Rate,
      top100kAgg.free_hits_h1_rate,
      top100kAgg.free_hits_h2_rate,
      top10kAgg.free_hits_h1_rate,
      top10kAgg.free_hits_h2_rate,
    ),
    bench_boosts: chipStat(
      userBenchBoost,
      avgBenchBoostH1Rate,
      avgBenchBoostH2Rate,
      top100kAgg.bench_boosts_h1_rate,
      top100kAgg.bench_boosts_h2_rate,
      top10kAgg.bench_boosts_h1_rate,
      top10kAgg.bench_boosts_h2_rate,
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
      average: activeCaptainAgg.avg_bonus,
      top100k_average: top100kCaptainAgg.avg_bonus,
      top10k_average: top10kCaptainAgg.avg_bonus,
    },
    avg_pts_per_transfer: {
      user: userAvgPtsPerTransfer,
      average: avgPtsPerTransferActive,
      top100k_average: avgPtsPerTransferTop100k,
      top10k_average: avgPtsPerTransferTop10k,
    },
    avg_gw_score: {
      user: userGwScore,
      average:
        ingestedGws.length > 0 ? avgTotalPoints / ingestedGws.length : null,
      top100k_average: top100kAgg.avg_gw_score,
      top10k_average: top10kAgg.avg_gw_score,
    },
    most_captained: {
      user_player_id: userMostCaptainedElement,
      user_player_name: userMostName,
      average_player_id: activeCaptainAgg.most_captained_id,
      average_player_name: activeCaptainAgg.most_captained_name,
      top100k_player_id: top100kCaptainAgg.most_captained_id,
      top100k_player_name: top100kCaptainAgg.most_captained_name,
      top10k_player_id: top10kCaptainAgg.most_captained_id,
      top10k_player_name: top10kCaptainAgg.most_captained_name,
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
      captain_average_partial:
        userPicks.incomplete ||
        (activeCaptainAgg.complete_managers > 0 &&
          activeCaptainAgg.avg_bonus === null),
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
