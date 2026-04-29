import { prisma } from "../database/client.js";
import { fetchEntryHistory } from "./fetchManager.js";
import { netPointsForEvent } from "./activityFilter.js";
import { fetchEntryEventPicks, summarizePicks } from "./fetchPicks.js";
import { delay } from "../utils.js";

type ChipPlay = { chip_name: string; num_played: number };

export type ComparisonStat = {
  user: number;
  average: number | null;
  top10k_average: number | null;
  top100k_average: number | null;
};

export type CaptainSummary = {
  user_player_id: number | null;
  user_player_name: string | null;
  average_player_id: number | null;
  average_player_name: string | null;
  top10k_player_id: number | null;
  top10k_player_name: string | null;
  top100k_player_id: number | null;
  top100k_player_name: string | null;
};

type StratumFilter = "active" | "stratum1" | "stratum1or2";

const stratumClauseFor = (f: StratumFilter): string => {
  if (f === "stratum1") return `AND ms.stratum = 1`;
  if (f === "stratum1or2") return `AND ms.stratum IN (1, 2)`;
  return ``;
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
  // and overall averages are direct measurements from `manager_picks`
  // joined to `history`.
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

// Per-GW points for a footballer across all fixtures in that round (covers
// double-GWs). Returns 0 if the player has no `history` rows for the round.
const footballerGwPoints = async (
  footballerId: number,
  gw: number,
): Promise<number> => {
  const rows = await prisma.history.findMany({
    where: { footballer_id: footballerId, round: gw },
    select: { total_points: true },
  });
  return rows.reduce((acc, r) => acc + r.total_points, 0);
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

// Compute the user's captain bonus by fetching their picks per GW from FPL,
// then summing each captained player's GW points × (multiplier − 1).
// Also returns the most-frequently-captained element id across the range.
//
// Parallel fetches in batches — 38 sequential calls would exceed the
// frontend's 8s timeout. FPL handles modest parallelism fine; one batch
// per ~150ms in practice.
const PICKS_BATCH_SIZE = 6;

const userCaptainStats = async (
  entryId: number,
  startGw: number,
  endGw: number,
): Promise<{ bonus: number; mostCaptainedElement: number | null }> => {
  const gws: number[] = [];
  for (let g = startGw; g <= endGw; g++) gws.push(g);

  type PickResult = {
    gw: number;
    captain_element: number | null;
    captain_multiplier: number | null;
  };
  const results: PickResult[] = [];

  for (let i = 0; i < gws.length; i += PICKS_BATCH_SIZE) {
    const batch = gws.slice(i, i + PICKS_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (gw): Promise<PickResult | null> => {
        try {
          const payload = await fetchEntryEventPicks(entryId, gw);
          const { captain_element, captain_multiplier } = summarizePicks(
            payload.picks ?? [],
          );
          return { gw, captain_element, captain_multiplier };
        } catch {
          return null;
        }
      }),
    );
    for (const r of batchResults) {
      if (r) results.push(r);
    }
    if (i + PICKS_BATCH_SIZE < gws.length) await delay(60);
  }

  // Captain bonus from successful picks. Run the GW-point lookups in
  // parallel — they hit our local DB so they're cheap.
  const bonusContribs = await Promise.all(
    results
      .filter(
        (
          r,
        ): r is PickResult & {
          captain_element: number;
          captain_multiplier: number;
        } =>
          r.captain_element !== null &&
          r.captain_multiplier !== null &&
          r.captain_multiplier > 1,
      )
      .map(async (r) => {
        const pts = await footballerGwPoints(r.captain_element, r.gw);
        return pts * (r.captain_multiplier - 1);
      }),
  );
  const bonus = bonusContribs.reduce((acc, n) => acc + n, 0);

  const captainCounts = new Map<number, number>();
  for (const r of results) {
    if (r.captain_element !== null) {
      captainCounts.set(
        r.captain_element,
        (captainCounts.get(r.captain_element) ?? 0) + 1,
      );
    }
  }

  let mostCaptainedElement: number | null = null;
  let max = 0;
  for (const [el, count] of captainCounts.entries()) {
    if (count > max) {
      max = count;
      mostCaptainedElement = el;
    }
  }
  return { bonus, mostCaptainedElement };
};

// Sample-side captain bonus average across stratum filter. Returns null if
// no sample. `coverageThresholdSampleSize` lets the caller decide whether
// to surface the result or null it out for partial backfills.
const sampleCaptainBonusAvg = async (
  startGw: number,
  endGw: number,
  stratumFilter: StratumFilter,
): Promise<{ avg: number | null; sample_size: number }> => {
  const stratumClause = stratumClauseFor(stratumFilter);
  const rows = await prisma.$queryRawUnsafe<
    Array<{ avg_bonus: number | null; sample_size: number }>
  >(
    `
    SELECT
      AVG(t.bonus_per_manager)::float AS avg_bonus,
      COUNT(*)::int AS sample_size
    FROM (
      SELECT mp.entry_id,
        SUM(
          COALESCE(gw_pts.pts, 0)
          * GREATEST(COALESCE(mp.captain_multiplier, 1) - 1, 0)
        )::float AS bonus_per_manager
      FROM manager_picks mp
      JOIN manager_summary ms ON ms.entry_id = mp.entry_id
      LEFT JOIN LATERAL (
        SELECT SUM(h.total_points)::int AS pts
        FROM history h
        WHERE h.footballer_id = mp.captain_element AND h.round = mp.gw
      ) gw_pts ON TRUE
      WHERE mp.gw BETWEEN $1 AND $2
        AND ms.rejected_reason IS NULL
        ${stratumClause}
      GROUP BY mp.entry_id
    ) t
  `,
    startGw,
    endGw,
  );
  const row = rows[0];
  return {
    avg: row?.avg_bonus ?? null,
    sample_size: row?.sample_size ?? 0,
  };
};

// Most-captained element across the range under the given filter.
const sampleMostCaptained = async (
  startGw: number,
  endGw: number,
  stratumFilter: StratumFilter,
): Promise<number | null> => {
  const stratumClause = stratumClauseFor(stratumFilter);
  const rows = await prisma.$queryRawUnsafe<
    Array<{ captain_element: number; picks: number }>
  >(
    `
    SELECT mp.captain_element, COUNT(*)::int AS picks
    FROM manager_picks mp
    JOIN manager_summary ms ON ms.entry_id = mp.entry_id
    WHERE mp.gw BETWEEN $1 AND $2
      AND ms.rejected_reason IS NULL
      AND mp.captain_element IS NOT NULL
      ${stratumClause}
    GROUP BY mp.captain_element
    ORDER BY picks DESC
    LIMIT 1
  `,
    startGw,
    endGw,
  );
  return rows[0]?.captain_element ?? null;
};

// Per-stratum aggregate: average per-manager total points, transfers, hits,
// bench points, GW score, plus chip rates from manager_picks.
const sampleStratumAggregates = async (
  startGw: number,
  endGw: number,
  stratumFilter: StratumFilter,
): Promise<{
  avg_total_points: number | null;
  avg_transfers: number | null;
  avg_hits: number | null;
  avg_bench: number | null;
  avg_gw_score: number | null;
  wildcards_rate: number | null;
  free_hits_rate: number | null;
  bench_boosts_rate: number | null;
  sample_size: number;
  with_hits_data: number;
  with_bench_data: number;
  with_transfers_data: number;
  picks_sample_size: number;
}> => {
  const stratumClause = stratumClauseFor(stratumFilter);

  // Aggregate per-entry then average across entries. Covers total points,
  // transfers, hits, bench, and GW score — all from manager_history.
  const histRows = await prisma.$queryRawUnsafe<
    Array<{
      avg_total_points: number | null;
      avg_transfers: number | null;
      avg_hits: number | null;
      avg_bench: number | null;
      avg_gw_score: number | null;
      sample_size: number;
      with_hits_data: number;
      with_bench_data: number;
      with_transfers_data: number;
    }>
  >(
    `
    SELECT
      AVG(total_points)::float AS avg_total_points,
      AVG(transfers)::float    AS avg_transfers,
      AVG(hits)::float         AS avg_hits,
      AVG(bench)::float        AS avg_bench,
      AVG(gw_score)::float     AS avg_gw_score,
      COUNT(*)::int            AS sample_size,
      SUM(CASE WHEN has_hits THEN 1 ELSE 0 END)::int AS with_hits_data,
      SUM(CASE WHEN has_bench THEN 1 ELSE 0 END)::int AS with_bench_data,
      SUM(CASE WHEN has_transfers THEN 1 ELSE 0 END)::int AS with_transfers_data
    FROM (
      SELECT
        mh.entry_id,
        SUM(mh.points)::int AS total_points,
        SUM(COALESCE(mh.event_transfers, 0))::int AS transfers,
        (SUM(COALESCE(mh.event_transfers_cost, 0)) / 4.0)::float AS hits,
        SUM(COALESCE(mh.points_on_bench, 0))::int AS bench,
        AVG(mh.points)::float AS gw_score,
        BOOL_OR(mh.event_transfers IS NOT NULL)      AS has_transfers,
        BOOL_OR(mh.event_transfers_cost IS NOT NULL) AS has_hits,
        BOOL_OR(mh.points_on_bench IS NOT NULL)      AS has_bench
      FROM manager_history mh
      JOIN manager_summary ms ON ms.entry_id = mh.entry_id
      WHERE mh.gw BETWEEN $1 AND $2
        AND ms.rejected_reason IS NULL
        ${stratumClause}
      GROUP BY mh.entry_id
    ) t
  `,
    startGw,
    endGw,
  );

  const histRow = histRows[0];

  // Chip rates from manager_picks. Rate = chip_plays_in_sample / sample_size,
  // matching the existing event-level avg semantics.
  const chipRows = await prisma.$queryRawUnsafe<
    Array<{
      wildcards: number;
      free_hits: number;
      bench_boosts: number;
      sample_size: number;
    }>
  >(
    `
    SELECT
      SUM(CASE WHEN mp.active_chip = 'wildcard' THEN 1 ELSE 0 END)::int AS wildcards,
      SUM(CASE WHEN mp.active_chip = 'freehit'  THEN 1 ELSE 0 END)::int AS free_hits,
      SUM(CASE WHEN mp.active_chip = 'bboost'   THEN 1 ELSE 0 END)::int AS bench_boosts,
      COUNT(DISTINCT mp.entry_id)::int AS sample_size
    FROM manager_picks mp
    JOIN manager_summary ms ON ms.entry_id = mp.entry_id
    WHERE mp.gw BETWEEN $1 AND $2
      AND ms.rejected_reason IS NULL
      ${stratumClause}
  `,
    startGw,
    endGw,
  );

  const chipRow = chipRows[0];
  const picksSampleSize = chipRow?.sample_size ?? 0;

  return {
    avg_total_points: histRow?.avg_total_points ?? null,
    avg_transfers: histRow?.avg_transfers ?? null,
    avg_hits: histRow?.avg_hits ?? null,
    avg_bench: histRow?.avg_bench ?? null,
    avg_gw_score: histRow?.avg_gw_score ?? null,
    wildcards_rate:
      picksSampleSize > 0 ? (chipRow?.wildcards ?? 0) / picksSampleSize : null,
    free_hits_rate:
      picksSampleSize > 0 ? (chipRow?.free_hits ?? 0) / picksSampleSize : null,
    bench_boosts_rate:
      picksSampleSize > 0
        ? (chipRow?.bench_boosts ?? 0) / picksSampleSize
        : null,
    sample_size: histRow?.sample_size ?? 0,
    with_hits_data: histRow?.with_hits_data ?? 0,
    with_bench_data: histRow?.with_bench_data ?? 0,
    with_transfers_data: histRow?.with_transfers_data ?? 0,
    picks_sample_size: picksSampleSize,
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

  // Count chips played by the user in the range. Each chip-type gets two
  // copies per season — one in the first half (GW1–19), one after the
  // mid-season reset (GW20–38) — so this can be 0, 1, or 2 for ranges
  // spanning the reset point. Backend reports the raw count; the UI
  // decides how to surface it (e.g. "X / Y" or a filled bar).
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

  // ---- Per-event aggregates from our DB (cheap; one query covers 1–38 rows).
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

  // ---- Sample-side per-stratum aggregates (active + top-10k + top-100k).
  const [activeAgg, top10kAgg, top100kAgg] = await Promise.all([
    sampleStratumAggregates(startGw, endGw, "active"),
    sampleStratumAggregates(startGw, endGw, "stratum1"),
    sampleStratumAggregates(startGw, endGw, "stratum1or2"),
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

  // ---- Captain bonus + most captained.
  // User-side captain stats run in parallel with the sample-side queries
  // because the FPL picks fetches are the slowest leg.
  const [
    userCaptain,
    activeBonus,
    top10kBonus,
    top100kBonus,
    activeMost,
    top10kMost,
    top100kMost,
  ] = await Promise.all([
    userCaptainStats(entryId, startGw, endGw),
    sampleCaptainBonusAvg(startGw, endGw, "active"),
    sampleCaptainBonusAvg(startGw, endGw, "stratum1"),
    sampleCaptainBonusAvg(startGw, endGw, "stratum1or2"),
    sampleMostCaptained(startGw, endGw, "active"),
    sampleMostCaptained(startGw, endGw, "stratum1"),
    sampleMostCaptained(startGw, endGw, "stratum1or2"),
  ]);

  const captainAveragePartial =
    activeBonus.sample_size === 0 ||
    activeBonus.sample_size < activeAgg.sample_size * COVERAGE_THRESHOLD;

  const [userMostName, activeMostName, top10kMostName, top100kMostName] =
    await Promise.all([
      footballerName(userCaptain.mostCaptainedElement),
      footballerName(activeMost),
      footballerName(top10kMost),
      footballerName(top100kMost),
    ]);

  return {
    entry_id: entryId,
    start_gw: startGw,
    end_gw: endGw,
    total_points: {
      user: userTotalPoints,
      average: avgTotalPoints,
      top10k_average: top10kAgg.avg_total_points,
      top100k_average: top100kAgg.avg_total_points,
    },
    transfers: {
      user: userTransfers,
      // Prefer the per-manager average from manager_history (real distribution
      // across the sample) when coverage is sufficient; fall back to the
      // event-level rate otherwise.
      average: avgTransfersFromHistory ?? avgTransfersTotal,
      top10k_average: top10kAgg.avg_transfers,
      top100k_average: top100kAgg.avg_transfers,
    },
    wildcards: {
      user: userWildcard,
      average: avgWildcardRate,
      top10k_average: top10kAgg.wildcards_rate,
      top100k_average: top100kAgg.wildcards_rate,
    },
    free_hits: {
      user: userFreeHit,
      average: avgFreeHitRate,
      top10k_average: top10kAgg.free_hits_rate,
      top100k_average: top100kAgg.free_hits_rate,
    },
    bench_boosts: {
      user: userBenchBoost,
      average: avgBenchBoostRate,
      top10k_average: top10kAgg.bench_boosts_rate,
      top100k_average: top100kAgg.bench_boosts_rate,
    },
    hits: {
      user: userHits,
      average: avgHits,
      top10k_average: avgHitsTop10k,
      top100k_average: avgHitsTop100k,
    },
    bench_points: {
      user: userBench,
      average: avgBench,
      top10k_average: avgBenchTop10k,
      top100k_average: avgBenchTop100k,
    },
    captain_bonus: {
      user: userCaptain.bonus,
      average: activeBonus.avg,
      top10k_average: top10kBonus.avg,
      top100k_average: top100kBonus.avg,
    },
    avg_gw_score: {
      user: userGwScore,
      average: activeAgg.avg_gw_score,
      top10k_average: top10kAgg.avg_gw_score,
      top100k_average: top100kAgg.avg_gw_score,
    },
    most_captained: {
      user_player_id: userCaptain.mostCaptainedElement,
      user_player_name: userMostName,
      average_player_id: activeMost,
      average_player_name: activeMostName,
      top10k_player_id: top10kMost,
      top10k_player_name: top10kMostName,
      top100k_player_id: top100kMost,
      top100k_player_name: top100kMostName,
    },
    notes: {
      hits_average_partial:
        avgHits !== null && activeAgg.with_hits_data < activeAgg.sample_size,
      bench_average_partial:
        avgBench !== null && activeAgg.with_bench_data < activeAgg.sample_size,
      captain_average_partial: captainAveragePartial,
    },
  };
};
