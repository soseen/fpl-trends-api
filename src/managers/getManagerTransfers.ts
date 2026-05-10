import { prisma } from "../database/client.js";
import { resolveTransfers, type TransferRow } from "./resolveTransfers.js";
import { fetchEntryHistory } from "./fetchManager.js";
import { resolvePicks, type PickRow } from "./resolvePicks.js";
import { fetchHistoryPointsByRound } from "./transferImpactCalc.js";
import {
  fetchPlayerGwRankStats,
  ownershipPct,
  playerGwKey,
  resolveRankImpactContext,
  type PlayerGwRankStat,
} from "./rankImpact.js";

// ----------------------------------------------------------------------------
// Public response types. Mirrored on the frontend in
// fpl-trends-app/src/queries/getManagerTransfers.ts.
// ----------------------------------------------------------------------------

// Active chip names from the FPL API. `null` for a regular GW with no chip.
export type ActiveChip =
  | "wildcard"
  | "freehit"
  | "bboost"
  | "3xc"
  | "manager"
  | null;

export type TransferImpactPlayer = {
  player_id: number;
  web_name: string;
  // FPL CDN photo code — same convention as TileSlot in getTeamImpact.ts.
  code: number;
  team_code: number;
  element_type: number; // 1=GK, 2=DEF, 3=MID, 4=FWD
  // Points contributed in the per-pair comparison window:
  //   Window  = [transfer.gw, lastOwnedGw] for normal transfers, where
  //             lastOwnedGw is the GW before the IN player was next
  //             transferred OUT (or endGw if still owned). For Free Hit
  //             transfers the window is [fhGw, fhGw] (single GW).
  //   IN side → SUM of history.points for GWs the player was on the
  //             field (multiplier > 0). Benched GWs contribute 0; the
  //             captain ×2 is intentionally NOT applied because we
  //             can't assume the user would have captained the OUT
  //             player too — keeping doubling on IN only creates a
  //             one-sided bias.
  //   OUT side → raw SUM of history.points across the window. We don't
  //             know how the user would have played the OUT player
  //             after they were sold, so we count what the player
  //             actually produced — symmetric with IN at the
  //             never-doubled level.
  points_in_window: number;
  // Estimated rank movement from this side of the transfer comparison.
  // IN players are positive point contributions; OUT players are the
  // counterfactual points left behind, so they are negative. Null when
  // the manager has no usable rank-density sample.
  rank_impact: number | null;
  // Average selected-by percentage across scored fixture GWs in the window.
  avg_ownership_pct: number | null;
};

export type TransferImpactPair = {
  player_in: TransferImpactPlayer;
  player_out: TransferImpactPlayer;
  net_points: number; // in.points_in_window - out.points_in_window
  // net_points translated through the manager's rank-density sample,
  // before hit cost.
  net_rank_impact: number | null;
  // GW the IN player was later transferred out of the user's squad
  // (i.e. lastOwnedGw + 1). null when:
  //   - the IN player is still owned at endGw (no future OUT in the log)
  //   - the transfer is a Free Hit (the auto-revert next GW is implicit
  //     and showing "GW t+1" on every FH tile would be noise)
  in_sold_gw: number | null;
};

// One per GW in which the manager either made (kept) transfers OR
// played a chip whose effect we want to surface (currently just bench
// boost). Chip GWs render with the chip badge in the header.
//
// Bench-boost-only GWs (no transfers) carry `bench_boost_points` so
// the UI can show a purely informational "+X bench points" tile —
// these points are NOT folded into `combined_net_points` because BB
// is prepared for, not a transfer effect, and including it would
// inflate transfer-comparison totals.
export type TransferImpactEvent = {
  gw: number;
  pairs: TransferImpactPair[];
  // Sum of pairs' net_points (no hit cost subtracted). Useful for the
  // frontend's "11 - 4 = 7 pts" formula.
  gross_net_points: number;
  // Hits cost in raw points (e.g., 4 = one -4 hit, 8 = two). Subtracted
  // from gross to get combined.
  hits_cost: number;
  // gross_net_points - hits_cost. Headline for the event card.
  combined_net_points: number;
  gross_rank_impact: number | null;
  hits_rank_impact: number | null;
  combined_rank_impact: number | null;
  chip: ActiveChip;
  // Set only when chip === "bboost". Display-only — not included in
  // any total or differential. null otherwise.
  bench_boost_points: number | null;
};

// Per-GW free-transfer state. One entry per GW in [start_gw, end_gw],
// regardless of whether the manager made any transfers — rolled GWs
// still get a row, with `used = 0` and `available` carried forward.
//
// Used to render the "X/Y" header chip on each card: X = transfers
// used this GW (FPL's `event_transfers` field; 0 for FH/WC/rolled),
// Y = FTs the manager had banked at the start of the GW.
//
// FT logic: starts at 1 for GW 1, increases by 1 each GW (capped at
// FT_CAP, currently 5 per the 2024-25+ FPL rules), and is decreased
// only by transfers that came out of the FT pool (transfers minus
// hits). FH/WC GWs don't consume FTs (the chip pays for those
// transfers), so the FT count rolls forward unchanged.
export type FreeTransferState = {
  gw: number;
  used: number;
  available: number | null;
};

export type ManagerTransfersResponse = {
  entry_id: number;
  start_gw: number;
  end_gw: number;
  events: TransferImpactEvent[]; // sorted by gw desc
  // Number of "real" transfers in range (after ghost filter).
  total_transfers: number;
  // Sum of combined_net_points across events (so hits are included).
  // The frontend's headline number.
  total_net_points: number;
  // Sum of combined_rank_impact across events. Null when rank density is
  // unavailable for the manager/range.
  total_rank_impact: number | null;
  // null when total_transfers === 0.
  avg_net_per_transfer: number | null;
  // Per-GW free-transfer state for the queried range.
  free_transfers: FreeTransferState[];
  incomplete: boolean;
  notes: {
    rank_per_point: number | null;
    stratum_avg_range_points: number | null;
    fallback_used: boolean;
    incomplete_picks: boolean;
  };
};

type ManagerTransfersOptions = {
  includeRank?: boolean;
};

// ----------------------------------------------------------------------------
// Internal helpers.
// ----------------------------------------------------------------------------

type FootballerMeta = {
  id: number;
  web_name: string | null;
  code: number | null;
  team_code: number | null;
  element_type: number | null;
  // Current FPL price (in 0.1m units, e.g. 100 = £10.0m). Used to pair
  // OUT/IN within a position by value tier so the per-pair labels read
  // "premium ↔ premium, mid ↔ mid, fodder ↔ fodder" rather than relying
  // on arbitrary FPL transfer-log order.
  now_cost: number | null;
};

const fetchFootballerMeta = async (
  ids: ReadonlyArray<number>,
): Promise<Map<number, FootballerMeta>> => {
  if (ids.length === 0) return new Map();
  const rows = await prisma.footballers.findMany({
    where: { id: { in: [...ids] } },
    select: {
      id: true,
      web_name: true,
      code: true,
      team_code: true,
      element_type: true,
      now_cost: true,
    },
  });
  return new Map(rows.map((r) => [r.id, r]));
};

const toPlayer = (
  id: number,
  meta: FootballerMeta | undefined,
  points: number,
  rankImpact: number | null,
  avgOwnershipPct: number | null,
): TransferImpactPlayer => ({
  player_id: id,
  web_name: meta?.web_name ?? `#${id}`,
  code: meta?.code ?? 0,
  team_code: meta?.team_code ?? 0,
  element_type: meta?.element_type ?? 0,
  points_in_window: points,
  rank_impact: rankImpact,
  avg_ownership_pct: avgOwnershipPct,
});

// (gw, player_id) → multiplier from the user's picks. Anything not in the
// map (player not in user's squad that GW) is treated as multiplier 0 by
// callers via `?? 0`.
type MultiplierMap = Map<number, Map<number, number>>;

const buildMultiplierMap = (picks: ReadonlyArray<PickRow>): MultiplierMap => {
  const m: MultiplierMap = new Map();
  for (const p of picks) {
    let inner = m.get(p.gw);
    if (!inner) {
      inner = new Map();
      m.set(p.gw, inner);
    }
    inner.set(p.element_id, p.multiplier);
  }
  return m;
};

// Set of element_ids in the user's final XV (15-man squad) for that GW.
// Used to filter "ghost" transfers — players that were transferred IN
// during the GW but reversed out before the deadline. Their final-XV
// presence is the source of truth for "did this swap actually stick".
type FinalXvMap = Map<number, Set<number>>;

const buildFinalXvMap = (picks: ReadonlyArray<PickRow>): FinalXvMap => {
  const m: FinalXvMap = new Map();
  for (const p of picks) {
    let inner = m.get(p.gw);
    if (!inner) {
      inner = new Set();
      m.set(p.gw, inner);
    }
    inner.add(p.element_id);
  }
  return m;
};

// IN-player points: bench-aware but NOT captain-aware. For each GW in
// [transfer.gw, windowEnd], counts the player's raw points if they were
// on the field (multiplier > 0), and 0 if benched. The captain ×2 (and
// triple-captain ×3) is deliberately NOT applied — the user pointed out
// that doubling IN points without doubling OUT creates a one-sided bias,
// and we genuinely can't establish what the OUT player would have been
// captained as. So both sides cap at 1× per GW for symmetry.
const inPointsInWindow = (
  perRound: Map<string, number>,
  multipliers: MultiplierMap,
  playerId: number,
  fromGw: number,
  windowEnd: number,
): number => {
  let total = 0;
  for (let gw = fromGw; gw <= windowEnd; gw += 1) {
    const pts = perRound.get(`${playerId}:${gw}`) ?? 0;
    if (pts === 0) continue;
    const mult = multipliers.get(gw)?.get(playerId) ?? 0;
    if (mult <= 0) continue;
    total += pts;
  }
  return total;
};

// OUT-player points: raw history points scaled by `starterRate` across
// the window.
//
// `starterRate` is the fraction of "would I have started this player"
// to apply each GW:
//   - For single-transfer GWs we pass 1 (full raw — the user explicitly
//     chose this; they want to see the OUT player's actual scoring).
//   - For Wildcard / Free Hit GWs we pass the player's pre-chip
//     start-rate (started_GWs / owned_GWs in the user's actual lineup),
//     which corrects the WC bench-overcount problem: a manager who
//     wildcarded out 10 players couldn't have started all 10 each
//     week, only 11/15 of the kept squad would be live, and a true
//     bench-fodder transfer should not penalise the metric for points
//     it never could have earned. A rotational player gets partial
//     credit; a never-played dead pick gets ~0.
const outPointsInWindow = (
  perRound: Map<string, number>,
  playerId: number,
  fromGw: number,
  windowEnd: number,
  starterRate: number,
): number => {
  if (starterRate <= 0) return 0;
  let total = 0;
  for (let gw = fromGw; gw <= windowEnd; gw += 1) {
    total += (perRound.get(`${playerId}:${gw}`) ?? 0) * starterRate;
  }
  // Round to keep tile labels and gain pills integer-clean. The few
  // fractional points lost here are rounding noise on a metric that's
  // already a counterfactual estimate.
  return Math.round(total);
};

type RankWindowResult = {
  excess: number;
  rankImpact: number | null;
  avgOwnershipPct: number | null;
};

const rankResult = (
  excess: number,
  ownershipSum: number,
  ownershipCount: number,
  rankPerPoint: number | null,
): RankWindowResult => ({
  excess,
  rankImpact: rankPerPoint !== null ? excess * rankPerPoint : null,
  avgOwnershipPct: ownershipCount > 0 ? ownershipSum / ownershipCount : null,
});

// Transfer rank attribution deliberately excludes armband uplift. The
// Captaincy tab owns that piece; this tab measures the base ownership
// decision so the same Salah haul cannot be counted twice.
const inBaseRankImpactInWindow = (
  stats: Map<string, PlayerGwRankStat>,
  multipliers: MultiplierMap,
  playerId: number,
  fromGw: number,
  windowEnd: number,
  rankPerPoint: number | null,
): RankWindowResult => {
  let excess = 0;
  let ownershipSum = 0;
  let ownershipCount = 0;
  for (let gw = fromGw; gw <= windowEnd; gw += 1) {
    const stat = stats.get(playerGwKey(playerId, gw));
    if (!stat) continue;
    const ownership = ownershipPct(stat);
    const userExposure = (multipliers.get(gw)?.get(playerId) ?? 0) > 0 ? 1 : 0;
    excess += (userExposure - ownership) * stat.total_points;
    ownershipSum += ownership;
    ownershipCount += 1;
  }
  return rankResult(excess, ownershipSum, ownershipCount, rankPerPoint);
};

// `mode` selects which OUT-side excess to compute:
//   "did_not_have"        — actual scenario: user no longer owns OUT.
//                           Excess = -EO * starterRate * pts (rank-killer).
//   "kept_counterfactual" — counterfactual: user kept and started OUT.
//                           Excess = (1 - EO) * starterRate * pts (Team
//                           Impact-style attribution). Subtract this from
//                           the IN-side EO-aware excess to get the swap's
//                           rank delta — keeps Transfer Impact consistent
//                           with Team Impact's per-player attribution.
const outBaseRankImpactInWindow = (
  stats: Map<string, PlayerGwRankStat>,
  playerId: number,
  fromGw: number,
  windowEnd: number,
  starterRate: number,
  rankPerPoint: number | null,
  mode: "did_not_have" | "kept_counterfactual" = "did_not_have",
): RankWindowResult => {
  let excess = 0;
  let ownershipSum = 0;
  let ownershipCount = 0;
  if (starterRate <= 0) return rankResult(0, 0, 0, rankPerPoint);
  for (let gw = fromGw; gw <= windowEnd; gw += 1) {
    const stat = stats.get(playerGwKey(playerId, gw));
    if (!stat) continue;
    const ownership = ownershipPct(stat);
    const factor =
      mode === "kept_counterfactual"
        ? (1 - ownership) * starterRate
        : -ownership * starterRate;
    excess += factor * stat.total_points;
    ownershipSum += ownership;
    ownershipCount += 1;
  }
  return rankResult(excess, ownershipSum, ownershipCount, rankPerPoint);
};

// For each transfer (player B in at GW X), find the GW B was next
// transferred OUT (in a non-FH GW). Returns the OUT GW itself, NOT the
// last-owned GW — callers derive `lastOwnedGw = nextOutGw - 1` if they
// need it. Returns undefined when B was never permanently transferred
// out (still on the squad at end of season).
//
// Scans the FULL FPL transfer log (across the whole season, not just
// the queried range) so the "sold in GW X" badge can show sales that
// happened beyond the user's selected end GW.
//
// Skipping FH GWs is critical: FH transfers are ephemeral (squad reverts
// next GW), so they don't count as real OUT events for ownership
// purposes. `fhGws` MUST be the full-season FH set, not just the
// in-range one — otherwise out-of-range FH OUT events would falsely
// register as sales.
const buildNextOutGwMap = (
  fullTransfers: ReadonlyArray<TransferRow>,
  fhGws: ReadonlySet<number>,
): Map<string, number> => {
  const result = new Map<string, number>();
  const sorted = [...fullTransfers].sort((a, b) => a.gw - b.gw);
  for (const t of sorted) {
    const key = `${t.in_element}:${t.gw}`;
    if (fhGws.has(t.gw)) continue;
    if (result.has(key)) continue;
    for (const t2 of sorted) {
      if (t2.gw <= t.gw) continue;
      if (fhGws.has(t2.gw)) continue;
      if (t2.out_element !== t.in_element) continue;
      result.set(key, t2.gw);
      break;
    }
  }
  return result;
};

// For each Wildcard / Free Hit transfer's OUT player, compute the
// fraction of pre-chip GWs the user *actually started them* (i.e. had
// multiplier > 0 in the user's lineup). Used to scale that player's
// raw history points on the OUT side, so dead-bench picks contribute
// ~0 and rotational players get partial credit.
//
// Why only WC/FH and not single transfers: in a single-transfer GW
// you swap one player you cared enough about to actively manage; the
// user accepted "raw OUT" for those because the bench-suppress was
// hiding real points (e.g. Cunha post-sale). In WC/FH you swap many
// at once, including 4-of-15 bench fodder slots that *can't* all be
// "live"; raw OUT systematically overstates the "what I would have
// kept" counterfactual there.
//
// Captain doubling is collapsed into a binary "did they start?"
// signal — we treat any positive multiplier as 1 (consistent with the
// IN-side rule that captures captaincy at 1× too).
//
// Skips FH GWs while scanning history because the FH XV is temporary
// and doesn't reflect the underlying squad's role for the OUT player.
//
// Falls back to 1 (treat as full starter, full raw) when the player
// has no pre-chip ownership history we can use — e.g. WC at GW 1, or
// a player owned only inside earlier FH GWs.
const buildOutStarterRateMap = (
  realTransfers: ReadonlyArray<TransferRow>,
  multipliers: MultiplierMap,
  finalXv: FinalXvMap,
  fhGws: ReadonlySet<number>,
  wcGws: ReadonlySet<number>,
): Map<string, number> => {
  const result = new Map<string, number>();
  for (const t of realTransfers) {
    if (!fhGws.has(t.gw) && !wcGws.has(t.gw)) continue;
    const key = `${t.out_element}:${t.gw}`;
    let owned = 0;
    let started = 0;
    for (let g = 1; g < t.gw; g += 1) {
      if (fhGws.has(g)) continue;
      const xv = finalXv.get(g);
      if (!xv?.has(t.out_element)) continue;
      owned += 1;
      const mult = multipliers.get(g)?.get(t.out_element) ?? 0;
      if (mult > 0) started += 1;
    }
    result.set(key, owned > 0 ? started / owned : 1);
  }
  return result;
};

// Rank attribution uses start-rate for every OUT player, not only WC/FH
// events. Points view keeps the simpler raw-OUT convention for normal
// transfers, but rank view should not imply that selling a permanent
// bench slot cost rank every time that player later scored.
const buildOutRankStarterRateMap = (
  transfers: ReadonlyArray<TransferRow>,
  multipliers: MultiplierMap,
  finalXv: FinalXvMap,
  fhGws: ReadonlySet<number>,
): Map<string, number> => {
  const result = new Map<string, number>();
  for (const t of transfers) {
    const key = `${t.out_element}:${t.gw}`;
    let owned = 0;
    let started = 0;
    for (let g = 1; g < t.gw; g += 1) {
      if (fhGws.has(g)) continue;
      const xv = finalXv.get(g);
      if (!xv?.has(t.out_element)) continue;
      owned += 1;
      const mult = multipliers.get(g)?.get(t.out_element) ?? 0;
      if (mult > 0) started += 1;
    }
    result.set(key, owned > 0 ? started / owned : 1);
  }
  return result;
};

// Free Hit / Wildcard intra-GW chains (e.g. Raya → Pickford → Petrović)
// inflate the transfer count and clutter the UI with intermediate states
// the user never actually committed to. Collapse those GWs to net diffs:
//   removed = prev XV − current XV   (players actually leaving the squad)
//   added   = current XV − prev XV   (players actually joining the squad)
//
// The XV diff is the source of truth — iterating the FPL transfer log
// alone misses players whose only IN/OUT events were ghost-filtered as
// intermediate chain steps (e.g. Hill→A→Virgil collapsed to Hill→Virgil
// where the Hill→A transfer was filtered because A isn't in the final
// XV). The raw transfer log is only consulted for *ordering* the UI
// tiles in a way that loosely matches the order the user made the
// transfers.
//
// Pair removed↔added by element_type so the UI rows are positionally
// consistent (DEF→DEF, MID→MID). Squad sizes are fixed (2 GK / 5 DEF /
// 5 MID / 3 FWD), so per-position counts always match.
//
// Falls back to the ghost-filtered transfers for the GW when prev XV is
// missing (e.g. range starts on the chip GW so we have no GW(t-1) picks).
//
// Normal GWs are NOT collapsed — every transfer there represents a free
// transfer or a hit and is meaningful to surface individually.
const collapseChainTransfers = (
  realTransfers: ReadonlyArray<TransferRow>,
  rawInRange: ReadonlyArray<TransferRow>,
  finalXv: FinalXvMap,
  meta: Map<number, FootballerMeta>,
  fhGws: ReadonlySet<number>,
  wcGws: ReadonlySet<number>,
): TransferRow[] => {
  const collapseGws = new Set<number>([...fhGws, ...wcGws]);
  if (collapseGws.size === 0) return [...realTransfers];

  const byGwReal = new Map<number, TransferRow[]>();
  for (const t of realTransfers) {
    const arr = byGwReal.get(t.gw) ?? [];
    arr.push(t);
    byGwReal.set(t.gw, arr);
  }
  const byGwRaw = new Map<number, TransferRow[]>();
  for (const t of rawInRange) {
    const arr = byGwRaw.get(t.gw) ?? [];
    arr.push(t);
    byGwRaw.set(t.gw, arr);
  }

  const result: TransferRow[] = [];
  // Iterate every GW that has transfers (real OR raw, since collapse
  // GWs may have raw chain steps even when the ghost filter dropped
  // every "real" transfer).
  const allGws = new Set<number>([...byGwReal.keys(), ...byGwRaw.keys()]);
  for (const gw of allGws) {
    const realForGw = byGwReal.get(gw) ?? [];
    if (!collapseGws.has(gw)) {
      result.push(...realForGw);
      continue;
    }
    const prev = finalXv.get(gw - 1);
    const curr = finalXv.get(gw);
    if (!prev || !curr) {
      // No prev XV (e.g. range starts at the chip GW) — fall back to
      // ghost-filtered transfers rather than producing misleading
      // collapsed pairs.
      result.push(...realForGw);
      continue;
    }

    // Canonical removed/added from the XV diff. Independent of the
    // transfer log, so it can't be tripped up by ghost-filtering.
    const removed = new Set<number>();
    for (const id of prev) if (!curr.has(id)) removed.add(id);
    const added = new Set<number>();
    for (const id of curr) if (!prev.has(id)) added.add(id);

    // Group by position so we pair like-for-like (DEF→DEF, MID→MID, etc.)
    const removedByPos = new Map<number, number[]>();
    const addedByPos = new Map<number, number[]>();
    for (const id of removed) {
      const pos = meta.get(id)?.element_type ?? 0;
      const arr = removedByPos.get(pos) ?? [];
      arr.push(id);
      removedByPos.set(pos, arr);
    }
    for (const id of added) {
      const pos = meta.get(id)?.element_type ?? 0;
      const arr = addedByPos.get(pos) ?? [];
      arr.push(id);
      addedByPos.set(pos, arr);
    }
    // Within each position, sort both sides by FPL price descending and
    // pair index-by-index. So the most expensive OUT is paired with the
    // most expensive IN, the cheapest OUT with the cheapest IN, etc.
    // This makes the per-pair labels read intuitively as value-tier
    // swaps (premium ↔ premium, fodder ↔ fodder) rather than arbitrary
    // FPL transfer-log order, which is especially important on WC where
    // bench-fodder swaps (e.g. Marshall) shouldn't get visually paired
    // with premium starters (e.g. Watkins). The TOTAL is invariant under
    // any pairing — this only affects per-pair labels and tooltips.
    const byPriceDesc = (a: number, b: number): number =>
      (meta.get(b)?.now_cost ?? 0) - (meta.get(a)?.now_cost ?? 0);
    const baseEntry =
      realForGw[0]?.entry_id ?? byGwRaw.get(gw)?.[0]?.entry_id ?? 0;
    for (const [pos, outs] of removedByPos) {
      const ins = addedByPos.get(pos) ?? [];
      outs.sort(byPriceDesc);
      ins.sort(byPriceDesc);
      const len = Math.min(outs.length, ins.length);
      for (let i = 0; i < len; i += 1) {
        result.push({
          entry_id: baseEntry,
          gw,
          in_element: ins[i] as number,
          out_element: outs[i] as number,
          in_cost: 0,
          out_cost: 0,
        });
      }
    }
  }
  return result.sort((a, b) => a.gw - b.gw);
};

// ----------------------------------------------------------------------------
// Public entry point.
// ----------------------------------------------------------------------------

export const getManagerTransfers = async (
  entryId: number,
  startGw: number,
  endGw: number,
  options: ManagerTransfersOptions = {},
): Promise<ManagerTransfersResponse> => {
  const includeRank = options.includeRank ?? true;
  // Three parallel data sources:
  //   1. resolveTransfers — FPL transfers log, persisted + cached.
  //   2. fetchEntryHistory — chips played per GW + per-GW hits cost +
  //      points_on_bench. Single HTTP call (also dedup'd via the
  //      cachedManagerJson 5-min TTL upstream).
  //   3. resolvePicks — full XV per GW. Shared in-flight with the
  //      comparison & team-impact endpoints, so the picks fetches
  //      happen once across the My Trends panel.
  const finishedRange: number[] = [];
  for (let g = startGw; g <= endGw; g += 1) finishedRange.push(g);

  const [resolved, history, resolvedPicks] = await Promise.all([
    resolveTransfers(entryId, true),
    fetchEntryHistory(entryId),
    resolvePicks(entryId, finishedRange),
  ]);

  const inRange = resolved.rows.filter(
    (t: TransferRow) => t.gw >= startGw && t.gw <= endGw,
  );

  // Build per-GW chip + hits lookup from the FPL history payload.
  // `history.chips` lists every chip played; `history.current` has per-GW
  // event_transfers_cost. NOTE: we do NOT use history.points_on_bench
  // for Bench Boost — FPL zeroes that field when BB is active because
  // the bench has been "activated" into the score. We compute the BB
  // bonus ourselves below from the picks + per-round points.
  type GwMeta = { chip: ActiveChip; hits_cost: number; bench_points: number };
  const gwMeta = new Map<number, GwMeta>();
  for (const ev of history.current ?? []) {
    if (ev.event >= startGw && ev.event <= endGw) {
      gwMeta.set(ev.event, {
        chip: null,
        hits_cost: ev.event_transfers_cost ?? 0,
        bench_points: 0, // filled in for BB GWs after perRound is fetched
      });
    }
  }
  for (const c of history.chips ?? []) {
    const existing = gwMeta.get(c.event);
    if (existing) existing.chip = c.name as ActiveChip;
  }

  const finalXv = buildFinalXvMap(resolvedPicks.picks);
  const multipliers = buildMultiplierMap(resolvedPicks.picks);

  // Ghost filter: a transfer "really happened" iff the IN player ended
  // up in the user's final XV for that GW. Free-hit / wildcard GWs see
  // many transfers; only the ones whose IN players survived to the
  // deadline make it through. As a side-benefit this also drops
  // intra-GW round-trip (A→B then B→A) since neither A nor B end up in
  // the final XV.
  const realTransfers = inRange.filter((t) => {
    const xv = finalXv.get(t.gw);
    return xv ? xv.has(t.in_element) : false;
  });

  // Identify Free Hit and Wildcard GWs. FH drives the single-GW window
  // and the bench-suppress walk-back; WC + FH together drive the
  // intra-GW chain collapse so the UI shows net diffs (Raya → Petrović)
  // rather than chains (Raya → Pickford → Petrović).
  //
  // `allFhGws` covers the full-season FH set (including beyond endGw),
  // needed for the next-OUT scan so we can show "Sold in GW X" badges
  // for sales that happened past the queried range and correctly skip
  // out-of-range FH GWs (which would falsely register as sales).
  const fhGws = new Set<number>();
  const wcGws = new Set<number>();
  for (const [gw, m] of gwMeta) {
    if (m.chip === "freehit") fhGws.add(gw);
    if (m.chip === "wildcard") wcGws.add(gw);
  }
  const allFhGws = new Set<number>();
  for (const c of history.chips ?? []) {
    if (c.name === "freehit") allFhGws.add(c.event);
  }

  const eventByGw = new Map<number, TransferImpactEvent>();

  // Pre-fetch metadata for every player that could appear in display.
  // Includes both transfer-IN/OUT players and prev/curr XV members of
  // FH/WC GWs (initial-squad players never transferred IN otherwise).
  // Per-round points only need the displayed set, but we widen it here
  // to keep the two fetches parallel; the cost of a few extra rows is
  // negligible.
  // Identify Bench Boost GWs so we can include the bench players in
  // the player-data widening — needed to compute the BB bonus.
  const bbGws = new Set<number>();
  for (const [gw, m] of gwMeta) if (m.chip === "bboost") bbGws.add(gw);

  const widenedIds = new Set<number>();
  for (const t of realTransfers) {
    widenedIds.add(t.in_element);
    widenedIds.add(t.out_element);
  }
  for (const gw of [...fhGws, ...wcGws]) {
    for (const id of finalXv.get(gw - 1) ?? []) widenedIds.add(id);
    for (const id of finalXv.get(gw) ?? []) widenedIds.add(id);
  }
  for (const gw of bbGws) {
    for (const id of finalXv.get(gw) ?? []) widenedIds.add(id);
  }

  const minTransferGw =
    realTransfers.length > 0
      ? realTransfers.reduce(
          (acc, t) => (t.gw < acc ? t.gw : acc),
          realTransfers[0]!.gw,
        )
      : startGw;

  const emptyRankContext = {
    user_range_points: 0,
    stratum: null,
    rank_band: null,
    stratum_avg_range_points: null,
    rank_per_point: null,
  };

  const [meta, perRound, rankStats, rankContext] = await Promise.all([
    fetchFootballerMeta(Array.from(widenedIds)),
    fetchHistoryPointsByRound(Array.from(widenedIds), minTransferGw, endGw),
    includeRank
      ? fetchPlayerGwRankStats(Array.from(widenedIds), minTransferGw, endGw)
      : Promise.resolve(new Map<string, PlayerGwRankStat>()),
    includeRank
      ? resolveRankImpactContext(entryId, startGw, endGw, history)
      : Promise.resolve(emptyRankContext),
  ]);

  // Compute the actual Bench Boost bonus per GW: the sum of raw history
  // points scored by the user's bench (positions 12-15) in that GW.
  // This is what BB added to their score on top of the starting XI.
  // We can't read this from FPL's history.points_on_bench because it's
  // zeroed out when BB is active.
  for (const gw of bbGws) {
    const benchPicks = resolvedPicks.picks.filter(
      (p) => p.gw === gw && p.position >= 12 && p.position <= 15,
    );
    let benchPts = 0;
    for (const p of benchPicks) {
      benchPts += perRound.get(`${p.element_id}:${gw}`) ?? 0;
    }
    const m = gwMeta.get(gw);
    if (m) m.bench_points = benchPts;
  }

  // Collapse FH/WC intra-GW chains using the prev/curr XV diff — this
  // is what we iterate to build pairs. Normal GWs pass through. The
  // `inRange` raw log (un-ghost-filtered) is consulted for ordering
  // hints so the canonical XV diff doesn't lose its visual order.
  const displayTransfers = collapseChainTransfers(
    realTransfers,
    inRange,
    finalXv,
    meta,
    fhGws,
    wcGws,
  );

  // Build the next-OUT lookup from the FULL transfer log so we can
  // surface sales that happen past endGw on the "Sold in GW X" badge.
  // The window-end calc still caps at endGw; the badge does not.
  const nextOutGwMap = buildNextOutGwMap(resolved.rows, allFhGws);

  // Per-OUT-player starter rate for WC/FH events only (single-transfer
  // GWs use raw OUT, rate = 1).
  const outStarterRateMap = buildOutStarterRateMap(
    realTransfers,
    multipliers,
    finalXv,
    fhGws,
    wcGws,
  );
  const outRankStarterRateMap = buildOutRankStarterRateMap(
    displayTransfers,
    multipliers,
    finalXv,
    allFhGws,
  );

  const ensureEvent = (gw: number): TransferImpactEvent => {
    let ev = eventByGw.get(gw);
    if (!ev) {
      const m = gwMeta.get(gw);
      ev = {
        gw,
        pairs: [],
        gross_net_points: 0,
        hits_cost: m?.hits_cost ?? 0,
        combined_net_points: 0,
        gross_rank_impact: rankContext.rank_per_point !== null ? 0 : null,
        hits_rank_impact:
          rankContext.rank_per_point !== null
            ? -(m?.hits_cost ?? 0) * rankContext.rank_per_point
            : null,
        combined_rank_impact: rankContext.rank_per_point !== null ? 0 : null,
        chip: m?.chip ?? null,
        bench_boost_points: m?.chip === "bboost" ? (m.bench_points ?? 0) : null,
      };
      eventByGw.set(gw, ev);
    }
    return ev;
  };

  for (const t of displayTransfers) {
    const isFh = fhGws.has(t.gw);
    const isWc = wcGws.has(t.gw);
    const nextOutGw = nextOutGwMap.get(`${t.in_element}:${t.gw}`);
    // Per-pair window: both IN and OUT are evaluated over the same
    // [transfer.gw, lastOwnedGw_of_IN] range so the comparison stays
    // symmetric. Extending OUT past the IN player's tenure leads to
    // chain double-counting (Wirtz's post-sale raw counted both at
    // the GW 8 Saka→Wirtz pair and at the GW 13 Wirtz→Wilson pair),
    // which inflates losses on every chained transfer.
    const windowEnd = isFh
      ? t.gw
      : Math.min(nextOutGw !== undefined ? nextOutGw - 1 : endGw, endGw);

    const inPts = inPointsInWindow(
      perRound,
      multipliers,
      t.in_element,
      t.gw,
      windowEnd,
    );
    // Single-transfer GWs use raw OUT (rate=1); WC/FH GWs scale by the
    // OUT player's pre-chip start-rate so dead-bench picks don't inflate
    // the apparent "loss" of the chip event.
    const starterRate =
      isFh || isWc
        ? (outStarterRateMap.get(`${t.out_element}:${t.gw}`) ?? 1)
        : 1;
    const outPts = outPointsInWindow(
      perRound,
      t.out_element,
      t.gw,
      windowEnd,
      starterRate,
    );
    const inRank = inBaseRankImpactInWindow(
      rankStats,
      multipliers,
      t.in_element,
      t.gw,
      windowEnd,
      rankContext.rank_per_point,
    );
    const outRankStarterRate =
      outRankStarterRateMap.get(`${t.out_element}:${t.gw}`) ?? starterRate;
    // outRank (did_not_have) is kept ONLY for its avgOwnershipPct, which the
    // OUT-tile UI displays. The actual OUT contribution to the swap's rank
    // delta uses the kept-counterfactual variant below.
    const outRank = outBaseRankImpactInWindow(
      rankStats,
      t.out_element,
      t.gw,
      windowEnd,
      outRankStarterRate,
      rankContext.rank_per_point,
    );
    // EO-aware swap attribution: rank delta = (rank impact of having IN) −
    // (rank impact the user gave up by selling OUT, assuming OUT would've
    // been started). Subtracting the kept counterfactual gives the swap's
    // contribution relative to the same baseline Team Impact uses (the
    // average manager), so Transfer Impact and Team Impact attribute the
    // same number to the same player. The earlier `netPoints * rpp` formula
    // measured a different (broader) counterfactual and double-counted
    // movement that other managers also made.
    const outKeptCounterfactual = outBaseRankImpactInWindow(
      rankStats,
      t.out_element,
      t.gw,
      windowEnd,
      outRankStarterRate,
      rankContext.rank_per_point,
      "kept_counterfactual",
    );
    const netPoints = inPts - outPts;
    const inTransferRankImpact = inRank.rankImpact;
    const outTransferRankImpact =
      rankContext.rank_per_point !== null
        ? -outKeptCounterfactual.excess * rankContext.rank_per_point
        : null;
    // combined_net_points (raw point delta) and pairRankImpact (EO-aware)
    // can disagree in sign for high-EO ↔ low-low-EO swaps — e.g. bringing
    // in a 6-pt template captain (EO 0.95) while selling a 4-pt deep
    // differential (EO 0.05) is a positive net-points swap that loses
    // relative rank because the rest of the cohort made the same trade.
    // This matches LiveFPL behaviour and is intentional.
    const pairRankImpact =
      inTransferRankImpact !== null && outTransferRankImpact !== null
        ? inTransferRankImpact + outTransferRankImpact
        : null;
    // sold_gw is informative only for non-FH transfers (FH auto-reverts
    // next GW so showing "GW t+1" on every FH tile is noise). Always
    // shown when the IN player was actually sold, even if the sale was
    // beyond the user's selected range — a held-then-sold-much-later
    // player benefits from the badge regardless of the range slider.
    const inSoldGw = !isFh && nextOutGw !== undefined ? nextOutGw : null;

    const pair: TransferImpactPair = {
      player_in: toPlayer(
        t.in_element,
        meta.get(t.in_element),
        inPts,
        inTransferRankImpact,
        inRank.avgOwnershipPct,
      ),
      player_out: toPlayer(
        t.out_element,
        meta.get(t.out_element),
        outPts,
        outTransferRankImpact,
        outRank.avgOwnershipPct,
      ),
      net_points: netPoints,
      net_rank_impact: pairRankImpact,
      in_sold_gw: inSoldGw,
    };
    const ev = ensureEvent(t.gw);
    ev.pairs.push(pair);
    ev.gross_net_points += pair.net_points;
    ev.combined_net_points = ev.gross_net_points - ev.hits_cost;
    if (
      ev.gross_rank_impact !== null &&
      ev.hits_rank_impact !== null &&
      pair.net_rank_impact !== null
    ) {
      ev.gross_rank_impact += pair.net_rank_impact;
      ev.combined_rank_impact = ev.gross_rank_impact + ev.hits_rank_impact;
    } else {
      ev.gross_rank_impact = null;
      ev.hits_rank_impact = null;
      ev.combined_rank_impact = null;
    }
  }

  // Surface bench-boost-only GWs (no transfers) so the UI can render a
  // "+X bench points" tile. Other empty events (e.g. a chip GW with no
  // real transfers — rare) are dropped.
  for (const gw of fhGws) {
    // FH always has transfers (it's how you select the FH XV); a FH-only
    // GW with no displayable pairs would mean every transfer was reverted,
    // which the ghost filter already handles. Nothing to seed here.
    void gw;
  }
  for (const [gw, m] of gwMeta) {
    if (m.chip === "bboost" && !eventByGw.has(gw)) {
      ensureEvent(gw);
    }
  }
  for (const [gw, ev] of eventByGw) {
    if (ev.pairs.length === 0 && ev.chip !== "bboost") {
      eventByGw.delete(gw);
    }
  }

  const events = Array.from(eventByGw.values()).sort((a, b) => b.gw - a.gw);

  // Headline total INCLUDES Free Hit / Wildcard events. The points
  // they generated (or cost) are real and should be visible in the
  // overall figure — a successful WC that gained 80 pts shouldn't
  // be invisible in the headline. Total transfer COUNT, however, only
  // counts real transfers (FPL's `event_transfers` is 0 for chip
  // GWs by design, and the "How you compare" table uses that count).
  const totalNet = events.reduce((acc, ev) => acc + ev.combined_net_points, 0);
  const totalRank =
    rankContext.rank_per_point !== null
      ? events.reduce((acc, ev) => acc + (ev.combined_rank_impact ?? 0), 0)
      : null;
  const transferCount = displayTransfers.filter(
    (t) => !fhGws.has(t.gw) && !wcGws.has(t.gw),
  ).length;

  // FPL's public entry history exposes transfers made and hit cost, but
  // not the exact FT bank at the start of the GW. The authenticated
  // `/my-team` endpoint has live transfer state, but it is not public and
  // not historical. We therefore expose `used` only and leave `available`
  // null so the UI never invents a denominator.
  const fullChipByGw = new Map<number, ActiveChip>();
  for (const c of history.chips ?? []) {
    fullChipByGw.set(c.event, c.name as ActiveChip);
  }
  const sortedHistory = [...(history.current ?? [])].sort(
    (a, b) => a.event - b.event,
  );
  const freeTransfers: FreeTransferState[] = [];
  for (const ev of sortedHistory) {
    if (ev.event > endGw) break;
    const chipName = fullChipByGw.get(ev.event);
    const isChip = chipName === "wildcard" || chipName === "freehit";
    const used = isChip ? 0 : (ev.event_transfers ?? 0);
    if (ev.event >= startGw) {
      freeTransfers.push({ gw: ev.event, used, available: null });
    }
  }

  return {
    entry_id: entryId,
    start_gw: startGw,
    end_gw: endGw,
    events,
    total_transfers: transferCount,
    total_net_points: totalNet,
    total_rank_impact: totalRank,
    // Avg-per-transfer was always null; the totalNet now includes
    // chip-event gains/losses (which aren't "transfers" per se), so
    // dividing by transferCount would be a misleading mix. Kept the
    // field for response-shape compat but always reports null.
    avg_net_per_transfer: null,
    free_transfers: freeTransfers,
    incomplete: resolved.incomplete,
    notes: {
      rank_per_point: rankContext.rank_per_point,
      stratum_avg_range_points: rankContext.stratum_avg_range_points,
      fallback_used: rankContext.stratum === null,
      incomplete_picks: resolvedPicks.incomplete,
    },
  };
};

// Thin wrapper used by the comparison endpoint so the "Avg pts / transfer"
// row's user value matches the Transfer Impact section's headline. Both
// run through the same ghost-filter / multiplier-aware / hits-subtracted
// calculation in getManagerTransfers above. Kept as a separate exported
// function (rather than duplicating logic) so any future tweaks to the
// metric automatically reflect in both places.
export type UserTransferNet = {
  total_net: number;
  total_count: number;
  incomplete: boolean;
};

export const computeUserTransferNet = async (
  entryId: number,
  startGw: number,
  endGw: number,
): Promise<UserTransferNet> => {
  const resp = await getManagerTransfers(entryId, startGw, endGw, {
    includeRank: false,
  });
  return {
    total_net: resp.total_net_points,
    total_count: resp.total_transfers,
    incomplete: resp.incomplete,
  };
};
