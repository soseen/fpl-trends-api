import { prisma } from "../database/client.js";
import { resolvePicks } from "./resolvePicks.js";
import {
  captainExpectedBonus,
  fetchCaptainRatesInStratum,
  fetchPlayerGwRankStats,
  ownershipPct,
  playerGwKey,
  resolveRankImpactContext,
  SMALL_CAPTAIN_SAMPLE_THRESHOLD,
} from "./rankImpact.js";

// ----------------------------------------------------------------------------
// Public response types. Mirrored on the frontend in
// fpl-trends-app/src/queries/getCaptainImpact.ts.
// ----------------------------------------------------------------------------

export type CaptainPlayer = {
  player_id: number;
  web_name: string;
  // FPL CDN photo code — same convention as the rest of My Trends.
  code: number;
  team_code: number;
  element_type: number; // 1=GK, 2=DEF, 3=MID, 4=FWD
  // Player's raw points for the GW (history.total_points, summed across
  // multiple fixtures if it's a DGW).
  raw_points: number;
  // For the user side: actual pick multiplier (2 = captain, 3 = triple
  // captain, 0 = captained-but-didn't-play / vice took over).
  // For the template side: always 2 (template captain by definition).
  multiplier: number;
  // raw_points × max(multiplier, 1) — what the user actually scored for
  // their captain (or what the template captain would have given a user
  // who picked them as captain).
  effective_points: number;
  // These are measured in the user's rank stratum for this range. They
  // let the UI explain why 10 captain points from one player may move
  // rank very differently from 10 captain points from another.
  ownership_pct: number;
  captain_rate: number;
  triple_captain_rate: number;
};

// One per GW in which the user had a captain assigned. Compares the
// user's captain choice against TWO references:
//   1. Top 10k consensus (most-captained inside stratum 1) — what
//      experienced managers picked. Often a tighter benchmark.
//   2. Overall consensus (events.most_captained) — what the herd picked.
//
// Both reference captains use multiplier 2× by definition (they're
// the captain pick — what they would have scored a manager who
// captained them).
export type CaptainEvent = {
  gw: number;
  user_captain: CaptainPlayer;
  // null when the GW has no recorded most_captained / aggregated
  // top10k pick yet (typically a not-yet-finished GW or sparse data).
  template_captain: CaptainPlayer | null;
  top10k_captain: CaptainPlayer | null;
  matched_template: boolean;
  matched_top10k: boolean;
  // user_captain.effective_points − reference.effective_points. Positive
  // = your captain beat the reference; negative = reference would have
  // beaten you; zero = matched.
  differential_vs_template: number;
  differential_vs_top10k: number;
  // Isolated captaincy value: raw_points × (multiplier − 1). This strips
  // out the base ownership points, so it can sit next to Transfer Impact
  // without double-counting the same player score.
  user_captain_bonus: number;
  // Sample expectation inside the user's rank stratum:
  // SUM(player_points × (captain_rate + 2 × triple_captain_rate)).
  // Null when the sample has no captain data for the GW.
  expected_captain_bonus: number | null;
  captaincy_excess: number | null;
  rank_impact: number | null; // signed; positive = estimated rank improved
};

export type CaptainImpactResponse = {
  entry_id: number;
  start_gw: number;
  end_gw: number;
  events: CaptainEvent[]; // sorted by gw desc
  // Sum of effective points the user scored from their captains in range.
  total_user_captain_pts: number;
  // Sum of effective points the reference captains would have scored if
  // the user had captained them every GW (raw × 2).
  total_template_captain_pts: number;
  total_top10k_captain_pts: number;
  total_diff_vs_template: number; // user − template
  total_diff_vs_top10k: number; // user − top10k
  total_user_captain_bonus: number;
  total_expected_captain_bonus: number | null;
  total_captaincy_excess: number | null;
  total_rank_impact: number | null;
  matched_template_count: number; // GWs where user captained the template
  matched_top10k_count: number; // GWs where user captained the top-10k
  total_with_captain: number; // GWs in range where user had a captain
  notes: {
    rank_per_point: number | null;
    stratum_avg_range_points: number | null;
    fallback_used: boolean;
    partial_rank_impact: boolean;
    incomplete_picks: boolean;
    small_sample_gws: number[];
  };
};

// ----------------------------------------------------------------------------
// Implementation.
// ----------------------------------------------------------------------------

type FootballerMeta = {
  id: number;
  web_name: string | null;
  code: number | null;
  team_code: number | null;
  element_type: number | null;
};

const toCaptainPlayer = (
  id: number,
  meta: FootballerMeta | undefined,
  rawPoints: number,
  multiplier: number,
  ownership: number,
  captainRate: number,
  tripleCaptainRate: number,
): CaptainPlayer => {
  // Effective points use max(mult, 1): a captain whose intended pick was
  // benched (mult=0) still scored 0 for the user, while the template
  // side (always mult=2) doubles the raw points.
  const effective = rawPoints * Math.max(multiplier, multiplier === 0 ? 0 : 1);
  return {
    player_id: id,
    web_name: meta?.web_name ?? `#${id}`,
    code: meta?.code ?? 0,
    team_code: meta?.team_code ?? 0,
    element_type: meta?.element_type ?? 0,
    raw_points: rawPoints,
    multiplier,
    effective_points: effective,
    ownership_pct: ownership,
    captain_rate: captainRate,
    triple_captain_rate: tripleCaptainRate,
  };
};

// Pick the top-captained player per GW within stratum 1 (top 10k).
// Excludes captain_multiplier === 0 rows: those are managers whose
// intended captain didn't play and the vice took over, so the row's
// player wasn't actually captained for points. Falls back to the
// 2× rows (captained-and-played) as our best signal of "what top-10k
// managers actually captained successfully".
const fetchTop10kCaptainByGw = async (
  startGw: number,
  endGw: number,
): Promise<Map<number, number>> => {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ gw: number; captain_element: number; picks: number }>
  >(
    `
    SELECT gw, captain_element, SUM(picks)::int AS picks
    FROM stratum_captain_picks_gw
    WHERE stratum = 1
      AND gw BETWEEN $1 AND $2
      AND captain_multiplier >= 2
    GROUP BY gw, captain_element
    ORDER BY gw, picks DESC
    `,
    startGw,
    endGw,
  );
  const result = new Map<number, number>();
  for (const r of rows) {
    if (!result.has(r.gw)) result.set(r.gw, r.captain_element);
  }
  return result;
};

export const getCaptainImpact = async (
  entryId: number,
  startGw: number,
  endGw: number,
): Promise<CaptainImpactResponse> => {
  const range: number[] = [];
  for (let g = startGw; g <= endGw; g += 1) range.push(g);

  // Picks (user's captains), events (overall template captains), top-10k
  // aggregated captain picks, and rank-density context in parallel.
  const [resolvedPicks, eventRows, top10kByGw, rankContext] = await Promise.all([
    resolvePicks(entryId, range),
    prisma.events.findMany({
      where: { id: { gte: startGw, lte: endGw } },
      select: { id: true, most_captained: true },
    }),
    fetchTop10kCaptainByGw(startGw, endGw),
    resolveRankImpactContext(entryId, startGw, endGw),
  ]);

  const captainInfo = await fetchCaptainRatesInStratum(
    rankContext.stratum,
    startGw,
    endGw,
  );

  // For each GW, the user's captain is whoever has the highest multiplier
  // — that's the player who actually got the captain bonus, accounting
  // for vice-captain promotion when the intended captain didn't play.
  const userCaptainByGw = new Map<
    number,
    { element_id: number; multiplier: number }
  >();
  for (const p of resolvedPicks.picks) {
    if (p.multiplier < 2 && !p.is_captain) continue;
    const existing = userCaptainByGw.get(p.gw);
    if (!existing || p.multiplier > existing.multiplier) {
      userCaptainByGw.set(p.gw, {
        element_id: p.element_id,
        multiplier: p.multiplier,
      });
    }
  }

  const templateByGw = new Map<number, number | null>();
  for (const e of eventRows) templateByGw.set(e.id, e.most_captained ?? null);

  // Collect every player ID we'll need metadata + history points for.
  const playerIds = new Set<number>();
  for (const p of userCaptainByGw.values()) playerIds.add(p.element_id);
  for (const id of templateByGw.values()) if (id !== null) playerIds.add(id);
  for (const id of top10kByGw.values()) playerIds.add(id);
  for (const key of captainInfo.rates.keys()) {
    const playerId = Number(key.split(":")[0]);
    if (Number.isFinite(playerId)) playerIds.add(playerId);
  }

  const notes = {
    rank_per_point: rankContext.rank_per_point,
    stratum_avg_range_points: rankContext.stratum_avg_range_points,
    fallback_used: rankContext.stratum === null,
    partial_rank_impact: false,
    incomplete_picks: resolvedPicks.incomplete,
    small_sample_gws: range.filter((gw) => {
      const sampleSize = captainInfo.perGwSampleSize.get(gw) ?? 0;
      return sampleSize > 0 && sampleSize < SMALL_CAPTAIN_SAMPLE_THRESHOLD;
    }),
  };

  if (playerIds.size === 0) {
    return {
      entry_id: entryId,
      start_gw: startGw,
      end_gw: endGw,
      events: [],
      total_user_captain_pts: 0,
      total_template_captain_pts: 0,
      total_top10k_captain_pts: 0,
      total_diff_vs_template: 0,
      total_diff_vs_top10k: 0,
      total_user_captain_bonus: 0,
      total_expected_captain_bonus: null,
      total_captaincy_excess: null,
      total_rank_impact: null,
      matched_template_count: 0,
      matched_top10k_count: 0,
      total_with_captain: 0,
      notes,
    };
  }

  const idsArr = Array.from(playerIds);
  const [metaRows, statsMap] = await Promise.all([
    prisma.footballers.findMany({
      where: { id: { in: idsArr } },
      select: {
        id: true,
        web_name: true,
        code: true,
        team_code: true,
        element_type: true,
      },
    }),
    fetchPlayerGwRankStats(idsArr, startGw, endGw),
  ]);

  const metaMap = new Map<number, FootballerMeta>(
    metaRows.map((r) => [r.id, r]),
  );

  const playerForGw = (
    playerId: number,
    gw: number,
    multiplier: number,
  ): CaptainPlayer => {
    const key = playerGwKey(playerId, gw);
    const stat = statsMap.get(key);
    const rates = captainInfo.rates.get(key) ?? { cap_rate: 0, tc_rate: 0 };
    return toCaptainPlayer(
      playerId,
      metaMap.get(playerId),
      stat?.total_points ?? 0,
      multiplier,
      ownershipPct(stat),
      rates.cap_rate,
      rates.tc_rate,
    );
  };

  const events: CaptainEvent[] = [];
  for (const gw of range) {
    const userPick = userCaptainByGw.get(gw);
    if (!userPick) continue; // No captain for this GW (data gap pre-GW1 etc.)

    const userCap = playerForGw(userPick.element_id, gw, userPick.multiplier);

    const templateId = templateByGw.get(gw);
    let templateCap: CaptainPlayer | null = null;
    if (templateId !== null && templateId !== undefined) {
      templateCap = playerForGw(templateId, gw, 2);
    }

    const top10kId = top10kByGw.get(gw);
    let top10kCap: CaptainPlayer | null = null;
    if (top10kId !== undefined) {
      top10kCap = playerForGw(top10kId, gw, 2);
    }

    const matchedTemplate =
      templateCap !== null && userCap.player_id === templateCap.player_id;
    const matchedTop10k =
      top10kCap !== null && userCap.player_id === top10kCap.player_id;
    const diffVsTemplate =
      userCap.effective_points - (templateCap?.effective_points ?? 0);
    const diffVsTop10k =
      userCap.effective_points - (top10kCap?.effective_points ?? 0);
    const userCaptainBonus =
      userCap.raw_points * Math.max(userCap.multiplier - 1, 0);
    const expectedCaptainBonus = captainExpectedBonus(gw, captainInfo, statsMap);
    const captaincyExcess =
      expectedCaptainBonus === null
        ? null
        : userCaptainBonus - expectedCaptainBonus;
    const rankImpact =
      captaincyExcess !== null && rankContext.rank_per_point !== null
        ? captaincyExcess * rankContext.rank_per_point
        : null;

    events.push({
      gw,
      user_captain: userCap,
      template_captain: templateCap,
      top10k_captain: top10kCap,
      matched_template: matchedTemplate,
      matched_top10k: matchedTop10k,
      differential_vs_template: diffVsTemplate,
      differential_vs_top10k: diffVsTop10k,
      user_captain_bonus: userCaptainBonus,
      expected_captain_bonus: expectedCaptainBonus,
      captaincy_excess: captaincyExcess,
      rank_impact: rankImpact,
    });
  }

  events.sort((a, b) => b.gw - a.gw);

  const totalUser = events.reduce(
    (s, e) => s + e.user_captain.effective_points,
    0,
  );
  const totalTemplate = events.reduce(
    (s, e) => s + (e.template_captain?.effective_points ?? 0),
    0,
  );
  const totalTop10k = events.reduce(
    (s, e) => s + (e.top10k_captain?.effective_points ?? 0),
    0,
  );
  const matchedTemplateCount = events.filter((e) => e.matched_template).length;
  const matchedTop10kCount = events.filter((e) => e.matched_top10k).length;
  const eventsWithExpected = events.filter(
    (
      e,
    ): e is CaptainEvent & {
      expected_captain_bonus: number;
      captaincy_excess: number;
    } =>
      e.expected_captain_bonus !== null &&
      e.captaincy_excess !== null,
  );
  const rankedEvents = eventsWithExpected.filter(
    (
      e,
    ): e is CaptainEvent & {
      expected_captain_bonus: number;
      captaincy_excess: number;
      rank_impact: number;
    } => e.rank_impact !== null,
  );
  const totalUserCaptainBonus = events.reduce(
    (s, e) => s + e.user_captain_bonus,
    0,
  );
  const totalExpectedCaptainBonus =
    eventsWithExpected.length > 0
      ? eventsWithExpected.reduce((s, e) => s + e.expected_captain_bonus, 0)
      : null;
  const totalCaptaincyExcess =
    eventsWithExpected.length > 0
      ? eventsWithExpected.reduce((s, e) => s + e.captaincy_excess, 0)
      : null;
  const totalRankImpact =
    rankedEvents.length > 0
      ? rankedEvents.reduce((s, e) => s + e.rank_impact, 0)
      : null;
  notes.partial_rank_impact = rankedEvents.length !== events.length;

  return {
    entry_id: entryId,
    start_gw: startGw,
    end_gw: endGw,
    events,
    total_user_captain_pts: totalUser,
    total_template_captain_pts: totalTemplate,
    total_top10k_captain_pts: totalTop10k,
    total_diff_vs_template: totalUser - totalTemplate,
    total_diff_vs_top10k: totalUser - totalTop10k,
    total_user_captain_bonus: totalUserCaptainBonus,
    total_expected_captain_bonus: totalExpectedCaptainBonus,
    total_captaincy_excess: totalCaptaincyExcess,
    total_rank_impact: totalRankImpact,
    matched_template_count: matchedTemplateCount,
    matched_top10k_count: matchedTop10kCount,
    total_with_captain: events.length,
    notes,
  };
};
