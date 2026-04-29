import { prisma } from "../database/client.js";
import { fetchEntrySummary, fetchEntryHistory } from "./fetchManager.js";
import { fetchEntryEventPicks } from "./fetchPicks.js";
import { netPointsForEvent } from "./activityFilter.js";
import { delay } from "../utils.js";

// ----------------------------------------------------------------------------
// Public response types. Mirrored on the frontend in
// fpl-trends-app/src/queries/getTeamImpact.ts.
// ----------------------------------------------------------------------------

export type TileSlot = {
  player_id: number;
  // FPL CDN photo code (used in `getFootballersImage`). Not the same as
  // `player_id` — `code` is FPL's stable cross-season identifier on the
  // photo URL, while `player_id` is the per-season element id we use in
  // history / picks rows.
  code: number;
  web_name: string;
  team_code: number;
  element_type: number; // 1=GK, 2=DEF, 3=MID, 4=FWD
  points_for_user: number;
  rank_impact: number; // signed; positive = rank improved
};

export type PlayerImpactGwBreakdown = {
  gw: number;
  multiplier: number;
  points: number;
  ownership_pct: number;
  eo: number;
  excess: number;
  rank_impact_gw: number;
};

export type PlayerImpact = {
  player_id: number;
  code: number;
  web_name: string;
  team_code: number;
  element_type: number;
  points_for_user: number; // sum of (multiplier × gw_pts) for GWs the player started
  raw_points: number; // sum of gw_pts (no multiplier) for GWs the user owned them
  starts: number;
  captaincies: number;
  triple_captaincies: number;
  played_count: number;
  avg_ownership_pct: number;
  avg_eo_in_stratum: number;
  rank_impact: number;
  per_gw: PlayerImpactGwBreakdown[];
};

export type TeamImpactResponse = {
  entry_id: number;
  start_gw: number;
  end_gw: number;
  most_played_xi: {
    gk: TileSlot;
    def: TileSlot[];
    mid: TileSlot[];
    fwd: TileSlot[];
  } | null;
  players: PlayerImpact[];
  totals: {
    user_range_points: number;
    stratum_avg_range_points: number | null;
    rank_per_point: number | null;
    attributed_excess: number;
  };
  notes: {
    incomplete_picks: boolean;
    fallback_used: boolean;
    small_sample_gws: number[];
  };
};

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

// Mirror of pickStratum() in getRangeRank.ts. Kept inline rather than
// imported because we don't need cMax here — a user with no stored stratum
// just falls back to global ownership.
const STRATUM_A_MAX = 10_000;
const STRATUM_B_MAX = 100_000;

// Match the batching used by getManagerComparison.userCaptainStats so we
// don't burst the FPL API harder than the comparison endpoint already does.
const PICKS_BATCH_SIZE = 6;

// EO computed from sample is unstable below this many picks rows for a GW.
// When triggered we drop captain/TC uplift and use global ownership only.
const SMALL_SAMPLE_THRESHOLD = 50;

// Density window for rank_per_point. 5 points either side of the user's
// total = a 10-point window over which we count sample managers, then
// divide by 10 to get managers/point density. Wider window smooths the
// estimate, narrower picks up local irregularities — 5 is a compromise.
const RANK_DENSITY_HALF_WINDOW = 5;

// Frequency-XI repair: a "started" GW means the user fielded the player
// (multiplier ≥ 1 — autosubs included).

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

type PickRow = {
  entry_id: number;
  gw: number;
  element_id: number;
  position: number;
  multiplier: number;
  is_captain: boolean;
  is_vice: boolean;
};

// Read what we already have persisted for this entry+range. Uses raw SQL
// because the new `manager_pick_elements` model is not yet in the
// generated Prisma client (DLL locked on Windows in dev).
const readPersistedPicks = async (
  entryId: number,
  startGw: number,
  endGw: number,
): Promise<PickRow[]> => {
  return prisma.$queryRawUnsafe<PickRow[]>(
    `
    SELECT entry_id, gw, element_id, position, multiplier, is_captain, is_vice
    FROM manager_pick_elements
    WHERE entry_id = $1 AND gw BETWEEN $2 AND $3
    `,
    entryId,
    startGw,
    endGw,
  );
};

const persistPicks = async (
  entryId: number,
  gw: number,
  picks: ReadonlyArray<{
    element: number;
    position: number;
    multiplier: number;
    is_captain: boolean;
    is_vice_captain: boolean;
  }>,
): Promise<void> => {
  if (picks.length === 0) return;
  // Build one INSERT with N tuples. ON CONFLICT DO NOTHING means a re-fetch
  // is cheap and idempotent.
  const values: unknown[] = [];
  const tuples = picks.map((p, i) => {
    const base = i * 7;
    values.push(
      entryId,
      gw,
      p.element,
      p.position,
      p.multiplier,
      p.is_captain,
      p.is_vice_captain,
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
  });
  await prisma.$executeRawUnsafe(
    `
    INSERT INTO manager_pick_elements
      (entry_id, gw, element_id, position, multiplier, is_captain, is_vice)
    VALUES ${tuples.join(", ")}
    ON CONFLICT (entry_id, gw, element_id) DO NOTHING
    `,
    ...values,
  );
};

// Resolve the user's full XV for every finished GW in [startGw, endGw],
// preferring our DB cache and falling back to the FPL API in batches of
// PICKS_BATCH_SIZE for any uncached GWs. Persists newly-fetched picks.
//
// Returns the full set of pick rows plus a flag indicating whether any
// requested GW failed to resolve.
const resolvePicks = async (
  entryId: number,
  finishedGws: number[],
): Promise<{ picks: PickRow[]; incomplete: boolean }> => {
  if (finishedGws.length === 0) return { picks: [], incomplete: false };

  const startGw = Math.min(...finishedGws);
  const endGw = Math.max(...finishedGws);
  const persisted = await readPersistedPicks(entryId, startGw, endGw);

  const cachedGws = new Set(persisted.map((r) => r.gw));
  const missingGws = finishedGws.filter((g) => !cachedGws.has(g));

  let incomplete = false;
  const fetched: PickRow[] = [];

  for (let i = 0; i < missingGws.length; i += PICKS_BATCH_SIZE) {
    const batch = missingGws.slice(i, i + PICKS_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (gw) => {
        try {
          const payload = await fetchEntryEventPicks(entryId, gw);
          return { gw, picks: payload.picks ?? [] };
        } catch {
          return null;
        }
      }),
    );
    for (const r of results) {
      if (!r) {
        incomplete = true;
        continue;
      }
      // Persist (non-blocking persist would be nice but we keep it simple
      // and consistent with the rest of the codebase).
      await persistPicks(entryId, r.gw, r.picks);
      for (const p of r.picks) {
        fetched.push({
          entry_id: entryId,
          gw: r.gw,
          element_id: p.element,
          position: p.position,
          multiplier: p.multiplier,
          is_captain: p.is_captain,
          is_vice: p.is_vice_captain,
        });
      }
    }
    if (i + PICKS_BATCH_SIZE < missingGws.length) await delay(60);
  }

  return { picks: [...persisted, ...fetched], incomplete };
};

type FootballerInfo = {
  id: number;
  code: number;
  web_name: string;
  team_code: number;
  element_type: number;
};

const fetchFootballerInfo = async (
  ids: number[],
): Promise<Map<number, FootballerInfo>> => {
  if (ids.length === 0) return new Map();
  const rows = await prisma.footballers.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      code: true,
      web_name: true,
      team_code: true,
      element_type: true,
    },
  });
  const map = new Map<number, FootballerInfo>();
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      code: r.code ?? 0,
      web_name: r.web_name ?? "Unknown",
      team_code: r.team_code ?? 0,
      element_type: r.element_type ?? 0,
    });
  }
  return map;
};

type PerGwPlayerStat = {
  total_points: number;
  selected: number;
  ranked_count: number;
};

// Map keyed by `${player_id}:${gw}`.
const fetchPlayerGwStats = async (
  playerIds: number[],
  startGw: number,
  endGw: number,
): Promise<Map<string, PerGwPlayerStat>> => {
  const map = new Map<string, PerGwPlayerStat>();
  if (playerIds.length === 0) return map;

  // Sum across multi-fixture rows in the same GW (DGWs / postponements).
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      footballer_id: number;
      round: number;
      total_points: number;
      selected: number;
      ranked_count: number;
    }>
  >(
    `
    SELECT
      h.footballer_id,
      h.round,
      SUM(h.total_points)::int AS total_points,
      MAX(h.selected)::int AS selected,
      COALESCE(MAX(e.ranked_count), 0)::int AS ranked_count
    FROM history h
    LEFT JOIN events e ON e.id = h.round
    WHERE h.round BETWEEN $1 AND $2
      AND h.footballer_id = ANY($3::int[])
    GROUP BY h.footballer_id, h.round
    `,
    startGw,
    endGw,
    playerIds,
  );
  for (const r of rows) {
    map.set(`${r.footballer_id}:${r.round}`, {
      total_points: r.total_points,
      selected: r.selected,
      ranked_count: r.ranked_count,
    });
  }
  return map;
};

// Captain / TC rates per (player, gw) within stratum, sample-derived.
// Returns map keyed `${player_id}:${gw}` plus per-GW sample sizes.
const fetchCaptainRatesInStratum = async (
  stratum: number | null,
  startGw: number,
  endGw: number,
): Promise<{
  rates: Map<string, { cap_rate: number; tc_rate: number }>;
  perGwSampleSize: Map<number, number>;
}> => {
  const rates = new Map<string, { cap_rate: number; tc_rate: number }>();
  const perGwSampleSize = new Map<number, number>();
  if (stratum === null) return { rates, perGwSampleSize };

  const stratumClause = `AND ms.stratum = $3`;

  // Sample size per GW = distinct managers in stratum with a manager_picks
  // row that GW.
  const sampleRows = await prisma.$queryRawUnsafe<
    Array<{ gw: number; sample_size: number }>
  >(
    `
    SELECT mp.gw, COUNT(DISTINCT mp.entry_id)::int AS sample_size
    FROM manager_picks mp
    JOIN manager_summary ms ON ms.entry_id = mp.entry_id
    WHERE mp.gw BETWEEN $1 AND $2
      AND ms.rejected_reason IS NULL
      ${stratumClause}
    GROUP BY mp.gw
    `,
    startGw,
    endGw,
    stratum,
  );
  for (const r of sampleRows) perGwSampleSize.set(r.gw, r.sample_size);

  const captainRows = await prisma.$queryRawUnsafe<
    Array<{
      gw: number;
      captain_element: number;
      captain_multiplier: number;
      n: number;
    }>
  >(
    `
    SELECT mp.gw, mp.captain_element, mp.captain_multiplier, COUNT(*)::int AS n
    FROM manager_picks mp
    JOIN manager_summary ms ON ms.entry_id = mp.entry_id
    WHERE mp.gw BETWEEN $1 AND $2
      AND ms.rejected_reason IS NULL
      AND mp.captain_element IS NOT NULL
      ${stratumClause}
    GROUP BY mp.gw, mp.captain_element, mp.captain_multiplier
    `,
    startGw,
    endGw,
    stratum,
  );
  for (const r of captainRows) {
    const sample = perGwSampleSize.get(r.gw) ?? 0;
    if (sample === 0) continue;
    const key = `${r.captain_element}:${r.gw}`;
    const existing = rates.get(key) ?? { cap_rate: 0, tc_rate: 0 };
    if (r.captain_multiplier === 3) {
      existing.tc_rate += r.n / sample;
    } else if (r.captain_multiplier === 2) {
      existing.cap_rate += r.n / sample;
    }
    rates.set(key, existing);
  }
  return { rates, perGwSampleSize };
};

// rank_per_point coefficient at the user's range total.
//
// Density = sample managers within ±RANK_DENSITY_HALF_WINDOW of user_total,
// divided by (2 × half-window). Multiply by stratum extrapolation factor
// (trueSize / probesWithHistory) — same ratio getRangeRank uses — to get
// rank places per point.
//
// Returns null if stratum can't be determined or the sample has no
// neighbours of the user (e.g. very early in the season with sparse data).
const computeRankPerPoint = async (
  stratum: number | null,
  startGw: number,
  endGw: number,
  userRangeTotal: number,
): Promise<{ rank_per_point: number | null; stratum_avg: number | null }> => {
  if (stratum === null) return { rank_per_point: null, stratum_avg: null };

  const lo = userRangeTotal - RANK_DENSITY_HALF_WINDOW;
  const hi = userRangeTotal + RANK_DENSITY_HALF_WINDOW;

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      neighbours: number;
      probes_with_history: number;
      avg_total: number | null;
    }>
  >(
    `
    WITH manager_totals AS (
      SELECT mh.entry_id, SUM(mh.points)::int AS total
      FROM manager_history mh
      JOIN manager_summary ms ON ms.entry_id = mh.entry_id
      WHERE mh.gw BETWEEN $1 AND $2
        AND ms.stratum = $3
        AND ms.rejected_reason IS NULL
      GROUP BY mh.entry_id
    )
    SELECT
      COUNT(*) FILTER (WHERE total BETWEEN $4 AND $5)::int AS neighbours,
      COUNT(*)::int AS probes_with_history,
      AVG(total)::float AS avg_total
    FROM manager_totals
    `,
    startGw,
    endGw,
    stratum,
    lo,
    hi,
  );
  const row = rows[0];
  if (!row || row.probes_with_history === 0) {
    return { rank_per_point: null, stratum_avg: null };
  }

  // Stratum true population — same logic as getRangeRank: use the latest
  // ranked_count for endGw if available, otherwise fall back to a wide
  // bound. We don't need exact accuracy here; this is a coefficient for
  // attribution display, not a primary rank estimate.
  const ev = await prisma.events.findUnique({
    where: { id: endGw },
    select: { ranked_count: true },
  });
  const rankedAtEnd = ev?.ranked_count ?? null;
  let trueSize: number;
  if (stratum === 1) trueSize = STRATUM_A_MAX;
  else if (stratum === 2) trueSize = STRATUM_B_MAX - STRATUM_A_MAX;
  else
    trueSize = Math.max(
      (rankedAtEnd ?? STRATUM_B_MAX * 100) - STRATUM_B_MAX,
      1,
    );

  const extrapolation = trueSize / row.probes_with_history;
  const density = row.neighbours / (2 * RANK_DENSITY_HALF_WINDOW);
  const rank_per_point = density * extrapolation;

  return {
    rank_per_point: rank_per_point > 0 ? rank_per_point : null,
    stratum_avg: row.avg_total,
  };
};

// Greedy "most-played XI" selection. Mirrors the formation constraints and
// repair loop from useBestScoringFootballers.ts but ranks by start count
// rather than by points. Position counts: 1 GK, 3≤DEF≤5, 3≤MID≤5,
// 1≤FWD≤3, total 11.
const ELEMENT_TYPE_GK = 1;
const ELEMENT_TYPE_DEF = 2;
const ELEMENT_TYPE_MID = 3;
const ELEMENT_TYPE_FWD = 4;

type PositionKey = "GK" | "DEF" | "MID" | "FWD";
const positionKey = (elementType: number): PositionKey | null => {
  if (elementType === ELEMENT_TYPE_GK) return "GK";
  if (elementType === ELEMENT_TYPE_DEF) return "DEF";
  if (elementType === ELEMENT_TYPE_MID) return "MID";
  if (elementType === ELEMENT_TYPE_FWD) return "FWD";
  return null;
};

const MIN_REQUIREMENTS: Record<PositionKey, number> = {
  GK: 1,
  DEF: 3,
  MID: 3,
  FWD: 1,
};
const MAX_LIMITS: Record<PositionKey, number> = {
  GK: 1,
  DEF: 5,
  MID: 5,
  FWD: 3,
};

const buildMostPlayedXi = (
  candidates: PlayerImpact[],
): TeamImpactResponse["most_played_xi"] => {
  const playable = candidates.filter((c) => c.starts > 0);
  if (playable.length === 0) return null;

  // Rank candidates by start count desc. Tie-break by points-for-user desc.
  const sorted = [...playable].sort((a, b) => {
    if (b.starts !== a.starts) return b.starts - a.starts;
    return b.points_for_user - a.points_for_user;
  });

  let selected: PlayerImpact[] = [];
  const positionCount: Record<PositionKey, number> = {
    GK: 0,
    DEF: 0,
    MID: 0,
    FWD: 0,
  };

  for (const p of sorted) {
    const key = positionKey(p.element_type);
    if (!key) continue;
    if (positionCount[key] >= MAX_LIMITS[key]) continue;
    selected.push(p);
    positionCount[key]++;
    if (selected.length === 11) break;
  }

  // Repair: if we hit max for some positions before reaching min for others,
  // swap the lowest-frequency picks of an over-min position for the highest-
  // frequency available pick of a missing position.
  let safety = 20;
  while (
    safety-- > 0 &&
    (Object.keys(MIN_REQUIREMENTS) as PositionKey[]).some(
      (k) => positionCount[k] < MIN_REQUIREMENTS[k],
    )
  ) {
    const missing = (Object.keys(MIN_REQUIREMENTS) as PositionKey[]).find(
      (k) => positionCount[k] < MIN_REQUIREMENTS[k],
    );
    if (!missing) break;

    // Find the last-added removable player from a position currently above
    // its minimum.
    const removable = [...selected].reverse().find((p) => {
      const k = positionKey(p.element_type);
      if (!k) return false;
      return positionCount[k] > MIN_REQUIREMENTS[k];
    });
    if (!removable) break;
    const removeKey = positionKey(removable.element_type);
    if (!removeKey) break;

    selected = selected.filter((p) => p.player_id !== removable.player_id);
    positionCount[removeKey]--;

    const selectedIds = new Set(selected.map((p) => p.player_id));
    const replacement = sorted.find(
      (p) =>
        positionKey(p.element_type) === missing &&
        !selectedIds.has(p.player_id),
    );
    if (!replacement) break;
    selected.push(replacement);
    positionCount[missing]++;
  }

  if (selected.length < 11) return null;

  const toTile = (p: PlayerImpact): TileSlot => ({
    player_id: p.player_id,
    code: p.code,
    web_name: p.web_name,
    team_code: p.team_code,
    element_type: p.element_type,
    points_for_user: p.points_for_user,
    rank_impact: p.rank_impact,
  });

  const gkPick = selected.find((p) => p.element_type === ELEMENT_TYPE_GK);
  if (!gkPick) return null;
  return {
    gk: toTile(gkPick),
    def: selected
      .filter((p) => p.element_type === ELEMENT_TYPE_DEF)
      .map(toTile),
    mid: selected
      .filter((p) => p.element_type === ELEMENT_TYPE_MID)
      .map(toTile),
    fwd: selected
      .filter((p) => p.element_type === ELEMENT_TYPE_FWD)
      .map(toTile),
  };
};

const pickStratum = (overallRank: number | null): 1 | 2 | 3 | null => {
  if (overallRank === null) return null;
  if (overallRank <= STRATUM_A_MAX) return 1;
  if (overallRank <= STRATUM_B_MAX) return 2;
  return 3;
};

// ----------------------------------------------------------------------------
// Public entry point
// ----------------------------------------------------------------------------

export const getTeamImpact = async (
  entryId: number,
  startGw: number,
  endGw: number,
): Promise<TeamImpactResponse> => {
  // Upfront fetches. summary and history come from FPL; events from our DB.
  const [summary, history, events] = await Promise.all([
    fetchEntrySummary(entryId),
    fetchEntryHistory(entryId),
    prisma.events.findMany({
      where: { id: { gte: startGw, lte: endGw }, finished: true },
      select: { id: true },
    }),
  ]);

  const finishedGws = events.map((e) => e.id).sort((a, b) => a - b);
  const finishedSet = new Set(finishedGws);

  // User's per-GW range total from the FPL history payload (net of hits).
  const eventsInRange = (history.current ?? []).filter((ev) =>
    finishedSet.has(ev.event),
  );
  const userRangeTotal = eventsInRange.reduce(
    (acc, ev) => acc + netPointsForEvent(ev),
    0,
  );

  if (finishedGws.length === 0) {
    return {
      entry_id: entryId,
      start_gw: startGw,
      end_gw: endGw,
      most_played_xi: null,
      players: [],
      totals: {
        user_range_points: 0,
        stratum_avg_range_points: null,
        rank_per_point: null,
        attributed_excess: 0,
      },
      notes: {
        incomplete_picks: false,
        fallback_used: true,
        small_sample_gws: [],
      },
    };
  }

  // Stratum picked from the user's current overall rank. If they're not
  // ranked yet (very new entry), fallback path uses global ownership only.
  const stratum = pickStratum(summary.summary_overall_rank);

  // Resolve picks (DB cache + FPL fallback for any missing GWs).
  const { picks, incomplete } = await resolvePicks(entryId, finishedGws);

  // Element ids the user owned at any GW in the range.
  const elementIds = Array.from(new Set(picks.map((p) => p.element_id)));

  // In parallel: footballer metadata, per-GW player points/ownership, and
  // captain-rate sample data.
  const [infoMap, statsMap, capInfo, rankInfo] = await Promise.all([
    fetchFootballerInfo(elementIds),
    fetchPlayerGwStats(elementIds, startGw, endGw),
    fetchCaptainRatesInStratum(stratum, startGw, endGw),
    computeRankPerPoint(stratum, startGw, endGw, userRangeTotal),
  ]);

  const smallSampleGws = new Set<number>();
  for (const [gw, n] of capInfo.perGwSampleSize.entries()) {
    if (n < SMALL_SAMPLE_THRESHOLD) smallSampleGws.add(gw);
  }
  // GWs we don't have any sample for at all → also treat as small-sample.
  for (const gw of finishedGws) {
    if (!capInfo.perGwSampleSize.has(gw)) smallSampleGws.add(gw);
  }

  // Per-player accumulators.
  type Acc = {
    info: FootballerInfo;
    points_for_user: number;
    raw_points: number;
    starts: number;
    captaincies: number;
    triple_captaincies: number;
    played_count: number;
    ownership_sum: number;
    eo_sum: number;
    excess_total: number;
    per_gw: PlayerImpactGwBreakdown[];
  };
  const accumulators = new Map<number, Acc>();

  for (const pick of picks) {
    if (!finishedSet.has(pick.gw)) continue;
    const info = infoMap.get(pick.element_id);
    if (!info) continue;

    const stat = statsMap.get(`${pick.element_id}:${pick.gw}`);
    const points = stat?.total_points ?? 0;
    const ownershipPct =
      stat && stat.ranked_count > 0
        ? Math.min(stat.selected / stat.ranked_count, 1)
        : 0;

    const capKey = `${pick.element_id}:${pick.gw}`;
    const cap = capInfo.rates.get(capKey);
    const sampleSize = capInfo.perGwSampleSize.get(pick.gw) ?? 0;

    let eo: number;
    if (sampleSize >= SMALL_SAMPLE_THRESHOLD && cap) {
      // EO = ownership + cap_rate × 1 + tc_rate × 2.
      eo = ownershipPct + cap.cap_rate + 2 * cap.tc_rate;
    } else if (sampleSize >= SMALL_SAMPLE_THRESHOLD) {
      // Player wasn't captained in stratum this GW → just ownership.
      eo = ownershipPct;
    } else {
      // Small sample: ownership-only fallback.
      eo = ownershipPct;
    }

    const excess = (pick.multiplier - eo) * points;
    const rankImpactGw =
      rankInfo.rank_per_point !== null ? excess * rankInfo.rank_per_point : 0;

    let acc = accumulators.get(pick.element_id);
    if (!acc) {
      acc = {
        info,
        points_for_user: 0,
        raw_points: 0,
        starts: 0,
        captaincies: 0,
        triple_captaincies: 0,
        played_count: 0,
        ownership_sum: 0,
        eo_sum: 0,
        excess_total: 0,
        per_gw: [],
      };
      accumulators.set(pick.element_id, acc);
    }

    acc.raw_points += points;
    if (pick.multiplier > 0) {
      acc.points_for_user += pick.multiplier * points;
      acc.played_count += 1;
      acc.starts += 1;
      if (pick.multiplier === 2) acc.captaincies += 1;
      if (pick.multiplier === 3) acc.triple_captaincies += 1;
    }
    acc.ownership_sum += ownershipPct;
    acc.eo_sum += eo;
    acc.excess_total += excess;
    acc.per_gw.push({
      gw: pick.gw,
      multiplier: pick.multiplier,
      points,
      ownership_pct: ownershipPct,
      eo,
      excess,
      rank_impact_gw: rankImpactGw,
    });
  }

  // Materialise PlayerImpact rows. Only include players who actually played
  // (multiplier ≥ 1 in at least one GW in range) per the user's spec.
  const players: PlayerImpact[] = [];
  for (const acc of accumulators.values()) {
    if (acc.played_count === 0) continue;
    const denom = acc.per_gw.length || 1;
    players.push({
      player_id: acc.info.id,
      code: acc.info.code,
      web_name: acc.info.web_name,
      team_code: acc.info.team_code,
      element_type: acc.info.element_type,
      points_for_user: acc.points_for_user,
      raw_points: acc.raw_points,
      starts: acc.starts,
      captaincies: acc.captaincies,
      triple_captaincies: acc.triple_captaincies,
      played_count: acc.played_count,
      avg_ownership_pct: acc.ownership_sum / denom,
      avg_eo_in_stratum: acc.eo_sum / denom,
      rank_impact:
        rankInfo.rank_per_point !== null
          ? acc.excess_total * rankInfo.rank_per_point
          : 0,
      per_gw: acc.per_gw.sort((a, b) => a.gw - b.gw),
    });
  }
  players.sort((a, b) => b.rank_impact - a.rank_impact);

  const attributedExcess = players.reduce(
    (acc, p) => acc + p.per_gw.reduce((s, r) => s + r.excess, 0),
    0,
  );

  return {
    entry_id: entryId,
    start_gw: startGw,
    end_gw: endGw,
    most_played_xi: buildMostPlayedXi(players),
    players,
    totals: {
      user_range_points: userRangeTotal,
      stratum_avg_range_points: rankInfo.stratum_avg,
      rank_per_point: rankInfo.rank_per_point,
      attributed_excess: attributedExcess,
    },
    notes: {
      incomplete_picks: incomplete,
      fallback_used: stratum === null,
      small_sample_gws: Array.from(smallSampleGws).sort((a, b) => a - b),
    },
  };
};
