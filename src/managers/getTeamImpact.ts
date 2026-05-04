import { prisma } from "../database/client.js";
import { fetchEntrySummary, fetchEntryHistory } from "./fetchManager.js";
import { netPointsForEvent } from "./activityFilter.js";
import { resolvePicks } from "./resolvePicks.js";

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

// One played fixture for a (player, gw) pair. Most GWs produce a
// single match; double GWs produce two. `team_score` / `opponent_score`
// are from the player's perspective (i.e. flipped for away fixtures so
// the first number is always the player's club).
export type PlayerMatch = {
  opponent_short: string;
  was_home: boolean;
  team_score: number | null;
  opponent_score: number | null;
};

export type PlayerImpactGwBreakdown = {
  gw: number;
  multiplier: number;
  points: number;
  ownership_pct: number;
  eo: number;
  excess: number;
  rank_impact_gw: number;
  // True if the player had a fixture in this GW (i.e. an `history` row
  // exists). False for blank GWs where the player's club didn't play —
  // the frontend renders these as "—" rather than "0" to make the
  // distinction from "had a fixture but blanked" obvious.
  had_fixture: boolean;
  // Per-fixture match info for this GW (opponent + score). Empty for
  // blanks; one entry for normal GWs; two for DGWs. Used by the frontend
  // to anchor each row in actual match context.
  matches: PlayerMatch[];
  // Match events for this GW. Same fields as `history.*` aggregated
  // across DGW fixtures. The frontend uses these to break down WHY a
  // player got a given score (1 G + 1 A vs 8 D + clean sheet, etc.)
  // and to highlight threshold-met defcon bonuses inline.
  minutes: number;
  goals: number;
  assists: number;
  clean_sheets: number;
  goals_conceded: number;
  defensive_contribution: number;
  saves: number;
  bonus: number;
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
  // Top 10 players the user did NOT have in their squad in the GW range
  // who scored points and were widely owned in the stratum — i.e. they
  // gave rank to other managers and so cost the user rank. `played_count`,
  // `starts`, `captaincies`, `triple_captaincies`, and `points_for_user`
  // are all 0 here. `raw_points` is the total points the player scored
  // across the GWs the user didn't own them (= points the user "missed").
  // `rank_impact` is signed and always non-positive.
  rank_killers: PlayerImpact[];
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

// EO computed from sample is unstable below this many picks rows for a GW.
// When triggered we drop captain/TC uplift and use global ownership only.
const SMALL_SAMPLE_THRESHOLD = 50;

// Density window for rank_per_point. We count sample managers within
// ±W points of the user, divide by 2W to get managers-per-point, and
// scale that by the stratum's true population. Width is a noise-vs-
// locality trade-off:
//   W=5  → tight locality, but users in sparse tails (or wide ranges
//          where the mode is well off the user's total) get 0 neighbours
//          and the whole attribution collapses to 0.
//   W=25 → averages over a 50-point band — still a small slice of any
//          stratum's spread, but reliably non-empty even in tails.
// Bumped from 5 to 25 after observing that the same player's
// rank_impact would swing 100× between adjacent ranges (e.g. 1-34 vs
// 8-34) for the same entry just because one window happened to be
// empty. Stability matters more than perfect locality for an attribution
// display.
const RANK_DENSITY_HALF_WINDOW = 25;

// Frequency-XI repair: a "started" GW means the user fielded the player
// (multiplier ≥ 1 — autosubs included).

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

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
  // Match events accumulated across all fixtures in this GW (DGWs sum,
  // single GWs are just the one row). Surfaced in the per-player
  // accordion's per-GW breakdown so users can see WHY a player got a
  // given score, not just the score itself.
  goals: number;
  assists: number;
  clean_sheets: number;
  goals_conceded: number;
  defensive_contribution: number;
  saves: number;
  bonus: number;
  minutes: number;
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
  // `clean_sheets` is special: in DGWs FPL credits the keeper / defender
  // a CS only if BOTH fixtures were clean (sum == fixture_count). For
  // simplicity we use SUM here too — for a single-fixture GW it's
  // exactly clean_sheets ∈ {0,1}; for the rare DGW it's 0/1/2 which
  // the UI can render as "1 of 2" or just the count. Same logic for
  // goals_conceded.
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      footballer_id: number;
      round: number;
      total_points: number;
      selected: number;
      ranked_count: number;
      goals: number;
      assists: number;
      clean_sheets: number;
      goals_conceded: number;
      defensive_contribution: number;
      saves: number;
      bonus: number;
      minutes: number;
    }>
  >(
    `
    SELECT
      h.footballer_id,
      h.round,
      SUM(h.total_points)::int AS total_points,
      MAX(h.selected)::int AS selected,
      COALESCE(MAX(e.ranked_count), 0)::int AS ranked_count,
      SUM(h.goals_scored)::int AS goals,
      SUM(h.assists)::int AS assists,
      SUM(h.clean_sheets)::int AS clean_sheets,
      SUM(h.goals_conceded)::int AS goals_conceded,
      COALESCE(SUM(h.defensive_contribution), 0)::int AS defensive_contribution,
      SUM(h.saves)::int AS saves,
      SUM(h.bonus)::int AS bonus,
      SUM(h.minutes)::int AS minutes
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
      goals: r.goals,
      assists: r.assists,
      clean_sheets: r.clean_sheets,
      goals_conceded: r.goals_conceded,
      defensive_contribution: r.defensive_contribution,
      saves: r.saves,
      bonus: r.bonus,
      minutes: r.minutes,
    });
  }
  return map;
};

// Map keyed by `${footballer_id}:${round}` for every (player, GW) pair in
// `finishedGws` where the player scored at least 1 point. Uses the same
// per-row aggregation as `fetchPlayerGwStats` but without the player-id
// filter — needed to compute rank-killer impact for players the user did
// NOT own. Filtering to `total_points > 0` keeps the result set small
// (~roughly the active player count × GWs in range).
const fetchAllPlayerGwStats = async (
  finishedGws: number[],
): Promise<Map<string, PerGwPlayerStat>> => {
  const map = new Map<string, PerGwPlayerStat>();
  if (finishedGws.length === 0) return map;

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      footballer_id: number;
      round: number;
      total_points: number;
      selected: number;
      ranked_count: number;
      goals: number;
      assists: number;
      clean_sheets: number;
      goals_conceded: number;
      defensive_contribution: number;
      saves: number;
      bonus: number;
      minutes: number;
    }>
  >(
    `
    SELECT
      h.footballer_id,
      h.round,
      SUM(h.total_points)::int AS total_points,
      MAX(h.selected)::int AS selected,
      COALESCE(MAX(e.ranked_count), 0)::int AS ranked_count,
      SUM(h.goals_scored)::int AS goals,
      SUM(h.assists)::int AS assists,
      SUM(h.clean_sheets)::int AS clean_sheets,
      SUM(h.goals_conceded)::int AS goals_conceded,
      COALESCE(SUM(h.defensive_contribution), 0)::int AS defensive_contribution,
      SUM(h.saves)::int AS saves,
      SUM(h.bonus)::int AS bonus,
      SUM(h.minutes)::int AS minutes
    FROM history h
    LEFT JOIN events e ON e.id = h.round
    WHERE h.round = ANY($1::int[])
    GROUP BY h.footballer_id, h.round
    HAVING SUM(h.total_points) > 0
    `,
    finishedGws,
  );
  for (const r of rows) {
    map.set(`${r.footballer_id}:${r.round}`, {
      total_points: r.total_points,
      selected: r.selected,
      ranked_count: r.ranked_count,
      goals: r.goals,
      assists: r.assists,
      clean_sheets: r.clean_sheets,
      goals_conceded: r.goals_conceded,
      defensive_contribution: r.defensive_contribution,
      saves: r.saves,
      bonus: r.bonus,
      minutes: r.minutes,
    });
  }
  return map;
};

// Per-fixture match info (opponent + score) keyed by `${footballer_id}:${round}`.
// Each value is a list because DGWs produce two matches under the same
// (player, GW) pair. Joined to `teams` to surface the opponent's
// short_name (the only club identifier the frontend needs to render).
const fetchPlayerMatches = async (
  playerIds: number[],
  finishedGws: number[],
): Promise<Map<string, PlayerMatch[]>> => {
  const map = new Map<string, PlayerMatch[]>();
  if (playerIds.length === 0 || finishedGws.length === 0) return map;

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      footballer_id: number;
      round: number;
      was_home: boolean;
      team_h_score: number | null;
      team_a_score: number | null;
      opponent_short: string | null;
      kickoff_time: Date;
    }>
  >(
    `
    SELECT
      h.footballer_id,
      h.round,
      h.was_home,
      h.team_h_score,
      h.team_a_score,
      h.kickoff_time,
      t.short_name AS opponent_short
    FROM history h
    LEFT JOIN teams t ON t.id = h.opponent_team
    WHERE h.round = ANY($1::int[])
      AND h.footballer_id = ANY($2::int[])
    ORDER BY h.footballer_id, h.round, h.kickoff_time
    `,
    finishedGws,
    playerIds,
  );

  for (const r of rows) {
    const key = `${r.footballer_id}:${r.round}`;
    const teamScore = r.was_home ? r.team_h_score : r.team_a_score;
    const opponentScore = r.was_home ? r.team_a_score : r.team_h_score;
    const list = map.get(key) ?? [];
    list.push({
      opponent_short: r.opponent_short ?? "?",
      was_home: r.was_home,
      team_score: teamScore,
      opponent_score: opponentScore,
    });
    map.set(key, list);
  }
  return map;
};

// Captain / TC rates per (player, gw) within stratum, served by the
// pre-aggregated `stratum_captain_picks_gw` table (rebuilt at the end of
// every populateManagers run via `rebuildStratumCaptainPicks`). Replaces
// two GROUP-BYs over the full stratum slice of `manager_picks` — both
// reads here are PK index lookups against ~17k rows total.
//
// Returns rates keyed `${player_id}:${gw}` plus per-GW active sample size.
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

  // Sample size per GW = sum of picks (across all captain/multiplier
  // combos) for that stratum and GW. The full sample is used now —
  // there is no longer a separate active subset.
  const sampleRows = await prisma.$queryRawUnsafe<
    Array<{ gw: number; sample_size: number }>
  >(
    `
    SELECT gw, SUM(picks)::int AS sample_size
    FROM stratum_captain_picks_gw
    WHERE gw BETWEEN $1 AND $2
      AND stratum = $3
    GROUP BY gw
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
    SELECT gw, captain_element, captain_multiplier, picks AS n
    FROM stratum_captain_picks_gw
    WHERE gw BETWEEN $1 AND $2
      AND stratum = $3
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

  // Stratum 3 is sub-sampled at 1-in-8 to bound the DISTINCT ON sort —
  // mirrors the trick in getRangeRank.stratumCounts. Density is invariant
  // under uniform sampling: neighbours ÷ population stays the same in
  // expectation, so the rank-per-point coefficient lands on the same
  // value (with a slightly wider confidence band).
  const subSampleClause = stratum === 3 ? `AND entry_id % 8 = 0` : ``;
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      neighbours: number;
      probes_with_history: number;
      avg_total: number | null;
    }>
  >(
    `
    WITH c_end AS (
      SELECT DISTINCT ON (entry_id) entry_id, cumulative_points
      FROM manager_cumulative
      WHERE stratum = $1
        AND gw BETWEEN $2 AND $3
        ${subSampleClause}
      ORDER BY entry_id, gw DESC
    ),
    c_start AS (
      SELECT DISTINCT ON (entry_id) entry_id, cumulative_points
      FROM manager_cumulative
      WHERE stratum = $1
        AND gw < $2
        ${subSampleClause}
      ORDER BY entry_id, gw DESC
    )
    SELECT
      COUNT(*) FILTER (WHERE total BETWEEN $4 AND $5)::int AS neighbours,
      COUNT(*)::int                                        AS probes_with_history,
      AVG(total)::float                                    AS avg_total
    FROM (
      SELECT c_end.cumulative_points - COALESCE(c_start.cumulative_points, 0) AS total
      FROM c_end
      LEFT JOIN c_start USING (entry_id)
    ) t
    `,
    stratum,
    startGw,
    endGw,
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
      rank_killers: [],
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

  // In parallel: footballer metadata, per-GW player points/ownership,
  // captain-rate sample data, rank density, and per-fixture match info
  // (so the frontend can show "vs ARS 2-1" alongside each per-GW row).
  const [infoMap, statsMap, capInfo, rankInfo, ownedMatchesMap] =
    await Promise.all([
      fetchFootballerInfo(elementIds),
      fetchPlayerGwStats(elementIds, startGw, endGw),
      fetchCaptainRatesInStratum(stratum, startGw, endGw),
      computeRankPerPoint(stratum, startGw, endGw, userRangeTotal),
      fetchPlayerMatches(elementIds, finishedGws),
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
      // Missing stat row → no fixture this GW (blank). Anything else
      // (including minutes=0 / suspended / injured) is "had fixture
      // but blanked" — the frontend treats these differently.
      had_fixture: !!stat,
      matches: ownedMatchesMap.get(`${pick.element_id}:${pick.gw}`) ?? [],
      minutes: stat?.minutes ?? 0,
      goals: stat?.goals ?? 0,
      assists: stat?.assists ?? 0,
      clean_sheets: stat?.clean_sheets ?? 0,
      goals_conceded: stat?.goals_conceded ?? 0,
      defensive_contribution: stat?.defensive_contribution ?? 0,
      saves: stat?.saves ?? 0,
      bonus: stat?.bonus ?? 0,
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

  // Rank killers: players the user did NOT have in their squad but who
  // scored points and were widely owned in the stratum, lifting OTHER
  // managers' totals and so dragging the user's relative rank down.
  // We only do this when rank_per_point is computable (otherwise the
  // attribution would always be 0 and the section would be hidden anyway).
  const rankKillers: PlayerImpact[] = [];
  if (rankInfo.rank_per_point !== null) {
    // GWs we have picks for. If a GW failed to load we have no idea what
    // the user owned, so we skip it rather than treat every player as
    // un-owned (which would generate a wildly inflated rank-killer list).
    const gwsWithPicks = new Set(picks.map((p) => p.gw));
    // (player_id, gw) tuples the user owned. Bench picks count as "owned"
    // — even an unused bench player isn't a "rank killer" in any
    // meaningful sense; the user had the option to play them.
    const userOwnedKeys = new Set(picks.map((p) => `${p.element_id}:${p.gw}`));

    const allStats = await fetchAllPlayerGwStats(finishedGws);

    type KillerAcc = {
      excess_total: number;
      raw_points_missed: number;
      ownership_sum: number;
      eo_sum: number;
      per_gw: PlayerImpactGwBreakdown[];
    };
    const killerAccs = new Map<number, KillerAcc>();

    for (const [key, stat] of allStats.entries()) {
      const [playerIdStr, gwStr] = key.split(":");
      if (playerIdStr === undefined || gwStr === undefined) continue;
      const playerId = Number(playerIdStr);
      const gw = Number(gwStr);

      if (!gwsWithPicks.has(gw)) continue;
      if (userOwnedKeys.has(`${playerId}:${gw}`)) continue;

      const ownershipPct =
        stat.ranked_count > 0
          ? Math.min(stat.selected / stat.ranked_count, 1)
          : 0;

      const capKey = `${playerId}:${gw}`;
      const cap = capInfo.rates.get(capKey);
      const sampleSize = capInfo.perGwSampleSize.get(gw) ?? 0;

      let eo: number;
      if (sampleSize >= SMALL_SAMPLE_THRESHOLD && cap) {
        eo = ownershipPct + cap.cap_rate + 2 * cap.tc_rate;
      } else {
        eo = ownershipPct;
      }

      if (eo === 0) continue;

      const excess = -eo * stat.total_points;
      const rankImpactGw = excess * rankInfo.rank_per_point;

      let acc = killerAccs.get(playerId);
      if (!acc) {
        acc = {
          excess_total: 0,
          raw_points_missed: 0,
          ownership_sum: 0,
          eo_sum: 0,
          per_gw: [],
        };
        killerAccs.set(playerId, acc);
      }
      acc.excess_total += excess;
      acc.raw_points_missed += stat.total_points;
      acc.ownership_sum += ownershipPct;
      acc.eo_sum += eo;
      acc.per_gw.push({
        gw,
        multiplier: 0,
        points: stat.total_points,
        ownership_pct: ownershipPct,
        eo,
        excess,
        rank_impact_gw: rankImpactGw,
        // Rank killers come from `fetchAllPlayerGwStats`, which already
        // filters to rows that exist in `history` (i.e. had a fixture
        // and total_points > 0).
        had_fixture: true,
        // Populated below once we've selected the top-10 — avoids
        // joining `teams` for every player who scored in the range.
        matches: [],
        minutes: stat.minutes,
        goals: stat.goals,
        assists: stat.assists,
        clean_sheets: stat.clean_sheets,
        goals_conceded: stat.goals_conceded,
        defensive_contribution: stat.defensive_contribution,
        saves: stat.saves,
        bonus: stat.bonus,
      });
    }

    // Top 10 by lowest excess_total (most negative — biggest rank cost).
    const top = Array.from(killerAccs.entries())
      .sort((a, b) => a[1].excess_total - b[1].excess_total)
      .slice(0, 10);

    const killerPlayerIds = top.map(([id]) => id);
    const [killerInfoMap, killerMatchesMap] = await Promise.all([
      fetchFootballerInfo(killerPlayerIds),
      fetchPlayerMatches(killerPlayerIds, finishedGws),
    ]);
    for (const [playerId, acc] of top) {
      const info = killerInfoMap.get(playerId);
      if (!info) continue;
      const denom = acc.per_gw.length || 1;
      const perGw = acc.per_gw
        .map((row) => ({
          ...row,
          matches: killerMatchesMap.get(`${playerId}:${row.gw}`) ?? [],
        }))
        .sort((a, b) => a.gw - b.gw);
      rankKillers.push({
        player_id: info.id,
        code: info.code,
        web_name: info.web_name,
        team_code: info.team_code,
        element_type: info.element_type,
        points_for_user: 0,
        raw_points: acc.raw_points_missed,
        starts: 0,
        captaincies: 0,
        triple_captaincies: 0,
        played_count: 0,
        avg_ownership_pct: acc.ownership_sum / denom,
        avg_eo_in_stratum: acc.eo_sum / denom,
        rank_impact: acc.excess_total * rankInfo.rank_per_point,
        per_gw: perGw,
      });
    }
  }

  return {
    entry_id: entryId,
    start_gw: startGw,
    end_gw: endGw,
    most_played_xi: buildMostPlayedXi(players),
    players,
    rank_killers: rankKillers,
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
