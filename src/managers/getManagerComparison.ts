import { prisma } from "../database/client.js";
import { fetchEntryHistory } from "./fetchManager.js";
import { netPointsForEvent } from "./activityFilter.js";
import { resolvePicks, captainPicksFromResolved } from "./resolvePicks.js";

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
//   - "active" → all strata (1, 2, 3), active subset only.
//   - "stratum1" → stratum 1 only, active subset only.
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
    SELECT captain_element, SUM(active_picks)::int AS picks
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
// hits, bench, captain_bonus, gw_score; chip rates for the stratum;
// coverage flags for transfers/hits/bench (gates the response when too
// few sampled managers have data in the range).
//
// Single SQL query against manager_cumulative — DISTINCT ON (entry_id)
// ORDER BY gw DESC pulls each entry's running total at the latest in-range
// GW (c_end) and at the latest pre-range GW (c_start). Subtraction inside
// the SELECT yields per-entity range deltas; AVG/COUNT/SUM_CASE roll them
// up. No GROUP BY over manager_history at request time — the heavy work
// happens once in `rebuildCumulativeForEntry` (per-entry, on populate
// visit) and `backfillManagerCumulative` (one-off bootstrap).
//
// `gws_played` lets `avg_gw_score` use per-manager (range_total /
// gws_played_in_range) instead of (range_total / nominal_range_width),
// matching the previous implementation that averaged each manager's
// `mh.points` per row.
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
  const stratumClause =
    stratumFilter === "stratum1"
      ? `AND stratum = 1`
      : `AND stratum IN (1, 2, 3)`;

  const rows = await prisma.$queryRawUnsafe<
    Array<{
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
    }>
  >(
    `
    WITH c_end AS (
      SELECT DISTINCT ON (entry_id)
             entry_id, cumulative_points, cumulative_transfers,
             cumulative_hits_cost, cumulative_bench, cumulative_captain_bonus,
             gws_played,
             chip_wildcard_h1, chip_wildcard_h2,
             chip_freehit_h1,  chip_freehit_h2,
             chip_bboost_h1,   chip_bboost_h2,
             has_transfers, has_hits, has_bench
      FROM manager_cumulative
      WHERE rejected_reason IS NULL
        ${stratumClause}
        AND gw BETWEEN $1 AND $2
      ORDER BY entry_id, gw DESC
    ),
    c_start AS (
      SELECT DISTINCT ON (entry_id)
             entry_id, cumulative_points, cumulative_transfers,
             cumulative_hits_cost, cumulative_bench, cumulative_captain_bonus,
             gws_played,
             chip_wildcard_h1, chip_wildcard_h2,
             chip_freehit_h1,  chip_freehit_h2,
             chip_bboost_h1,   chip_bboost_h2,
             has_transfers, has_hits, has_bench
      FROM manager_cumulative
      WHERE rejected_reason IS NULL
        ${stratumClause}
        AND gw < $1
      ORDER BY entry_id, gw DESC
    ),
    deltas AS (
      SELECT
        e.cumulative_points        - COALESCE(s.cumulative_points,        0) AS d_points,
        e.cumulative_transfers     - COALESCE(s.cumulative_transfers,     0) AS d_transfers,
        e.cumulative_hits_cost     - COALESCE(s.cumulative_hits_cost,     0) AS d_hits_cost,
        e.cumulative_bench         - COALESCE(s.cumulative_bench,         0) AS d_bench,
        e.cumulative_captain_bonus - COALESCE(s.cumulative_captain_bonus, 0) AS d_captain_bonus,
        e.gws_played               - COALESCE(s.gws_played,               0) AS d_gws,
        (e.chip_wildcard_h1 AND NOT COALESCE(s.chip_wildcard_h1, false))
          OR (e.chip_wildcard_h2 AND NOT COALESCE(s.chip_wildcard_h2, false)) AS played_wildcard,
        (e.chip_freehit_h1 AND NOT COALESCE(s.chip_freehit_h1, false))
          OR (e.chip_freehit_h2 AND NOT COALESCE(s.chip_freehit_h2, false))   AS played_freehit,
        (e.chip_bboost_h1 AND NOT COALESCE(s.chip_bboost_h1, false))
          OR (e.chip_bboost_h2 AND NOT COALESCE(s.chip_bboost_h2, false))     AS played_bboost,
        (e.has_transfers AND NOT COALESCE(s.has_transfers, false)) AS got_transfers_data,
        (e.has_hits      AND NOT COALESCE(s.has_hits,      false)) AS got_hits_data,
        (e.has_bench     AND NOT COALESCE(s.has_bench,     false)) AS got_bench_data
      FROM c_end e
      LEFT JOIN c_start s USING (entry_id)
    )
    SELECT
      AVG(d_points)::float                                AS avg_total_points,
      AVG(d_transfers)::float                             AS avg_transfers,
      AVG(d_hits_cost / 4.0)::float                       AS avg_hits,
      AVG(d_bench)::float                                 AS avg_bench,
      AVG(d_captain_bonus)::float                         AS avg_captain_bonus,
      AVG(d_points::float / NULLIF(d_gws, 0))::float      AS avg_gw_score,
      AVG(CASE WHEN played_wildcard THEN 1.0 ELSE 0.0 END)::float AS wildcards_rate,
      AVG(CASE WHEN played_freehit  THEN 1.0 ELSE 0.0 END)::float AS free_hits_rate,
      AVG(CASE WHEN played_bboost   THEN 1.0 ELSE 0.0 END)::float AS bench_boosts_rate,
      COUNT(*)::int                                                AS sample_size,
      SUM(CASE WHEN got_hits_data      THEN 1 ELSE 0 END)::int     AS with_hits_data,
      SUM(CASE WHEN got_bench_data     THEN 1 ELSE 0 END)::int     AS with_bench_data,
      SUM(CASE WHEN got_transfers_data THEN 1 ELSE 0 END)::int     AS with_transfers_data
    FROM deltas
    `,
    startGw,
    endGw,
  );

  const row = rows[0];
  return {
    avg_total_points: row?.avg_total_points ?? null,
    avg_transfers: row?.avg_transfers ?? null,
    avg_hits: row?.avg_hits ?? null,
    avg_bench: row?.avg_bench ?? null,
    avg_captain_bonus: row?.avg_captain_bonus ?? null,
    avg_gw_score: row?.avg_gw_score ?? null,
    wildcards_rate: row?.wildcards_rate ?? null,
    free_hits_rate: row?.free_hits_rate ?? null,
    bench_boosts_rate: row?.bench_boosts_rate ?? null,
    sample_size: row?.sample_size ?? 0,
    with_hits_data: row?.with_hits_data ?? 0,
    with_bench_data: row?.with_bench_data ?? 0,
    with_transfers_data: row?.with_transfers_data ?? 0,
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
  // captained, plus user picks resolution. All in parallel — sample
  // queries run on indexed cumulative tables (sub-second), most-captained
  // hits the tiny stratum_captain_picks_gw table (ms), and resolvePicks
  // dedups the FPL picks fetch with team-impact when both endpoints fire
  // simultaneously from the frontend.
  const [activeAgg, top10kAgg, activeMost, top10kMost, userPicks] =
    await Promise.all([
      sampleStratumAggregates(startGw, endGw, "active"),
      sampleStratumAggregates(startGw, endGw, "stratum1"),
      sampleMostCaptained(startGw, endGw, "active"),
      sampleMostCaptained(startGw, endGw, "stratum1"),
      resolvePicks(entryId, finishedGws),
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
    },
  };
};
