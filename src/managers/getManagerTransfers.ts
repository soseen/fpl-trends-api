import { prisma } from "../database/client.js";
import { resolveTransfers, type TransferRow } from "./resolveTransfers.js";
import { fetchEntryHistory } from "./fetchManager.js";
import { resolvePicks, type PickRow } from "./resolvePicks.js";
import { fetchHistoryPointsByRound } from "./transferImpactCalc.js";

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
  //   IN side → multiplier-aware: SUM of (pick_mult × history.points)
  //             across the window. Captures what the player actually did
  //             for the user (benched = 0; captained = 2×; etc.).
  //   OUT side → 0 if the OUT player was benched in the prev-GW (their
  //             last owned GW before this transfer), otherwise raw SUM
  //             of history.points across the window. The bench-suppress
  //             rule fixes the wildcard case where bench-warmers were
  //             being credited as if they'd have played.
  points_in_window: number;
};

export type TransferImpactPair = {
  player_in: TransferImpactPlayer;
  player_out: TransferImpactPlayer;
  net_points: number; // in.points_in_window − out.points_in_window
};

// One per GW in which the manager made (kept) transfers. Chip GWs render
// normally with the chip badge in the header. Solo Bench Boost GWs (no
// transfers) are dropped; BB+transfers GWs render their pairs normally
// and the BB chip badge is purely informational (bench points are not
// folded into the gain because BB is prepared for, not a transfer effect).
export type TransferImpactEvent = {
  gw: number;
  pairs: TransferImpactPair[];
  // Sum of pairs' net_points (no hit cost subtracted). Useful for the
  // frontend's "11 − 4 = 7 pts" formula.
  gross_net_points: number;
  // Hits cost in raw points (e.g., 4 = one −4 hit, 8 = two). Subtracted
  // from gross to get combined.
  hits_cost: number;
  // gross_net_points − hits_cost. Headline for the event card.
  combined_net_points: number;
  chip: ActiveChip;
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
  // null when total_transfers === 0.
  avg_net_per_transfer: number | null;
  incomplete: boolean;
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
    },
  });
  return new Map(rows.map((r) => [r.id, r]));
};

const toPlayer = (
  id: number,
  meta: FootballerMeta | undefined,
  points: number,
): TransferImpactPlayer => ({
  player_id: id,
  web_name: meta?.web_name ?? `#${id}`,
  code: meta?.code ?? 0,
  team_code: meta?.team_code ?? 0,
  element_type: meta?.element_type ?? 0,
  points_in_window: points,
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

// IN-player points: per-GW multiplier-aware. The window is
// [transfer.gw, windowEnd]; for GWs where the player isn't in the user's
// squad the multiplier map yields 0 and the contribution is 0
// (matches the "they're no longer ours, can't score for us" semantics
// for transfers-out-of-squad later in the range).
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
    total += pts * mult;
  }
  return total;
};

// OUT-player points: raw across the window when the player was started
// in the prev-GW; 0 otherwise. The bench-suppress rule fixes the
// wildcard case where bench-warmers were being credited as if they'd
// have played. Captaincy is NOT preserved on the OUT side (binary 0/raw
// only) — captaincy is a per-week decision and extending it through a
// multi-GW window would overstate.
const outPointsInWindow = (
  perRound: Map<string, number>,
  playerId: number,
  fromGw: number,
  windowEnd: number,
  prevStarted: boolean,
): number => {
  if (!prevStarted) return 0;
  let total = 0;
  for (let gw = fromGw; gw <= windowEnd; gw += 1) {
    total += perRound.get(`${playerId}:${gw}`) ?? 0;
  }
  return total;
};

// For each transfer (player B in at GW X), compute the GW B was last
// owned: the GW before B was next transferred OUT in a non-FH GW (or
// `endGw` if B is still owned). For FH transfers, lastOwnedGw is always
// the FH GW itself — players come back next GW.
//
// Skipping FH-OUT events while scanning is critical: a FH-OUT is
// ephemeral (the player returns to the underlying squad next GW), not
// a real ownership end. Treating it as one would shorten the ownership
// window of every player held through a FH.
const buildLastOwnedGwMap = (
  realTransfers: ReadonlyArray<TransferRow>,
  fhGws: ReadonlySet<number>,
  endGw: number,
): Map<string, number> => {
  const result = new Map<string, number>();
  for (const t of realTransfers) {
    const key = `${t.in_element}:${t.gw}`;
    if (fhGws.has(t.gw)) {
      result.set(key, t.gw);
      continue;
    }
    let lastOwned = endGw;
    for (const t2 of realTransfers) {
      if (t2.gw <= t.gw) continue;
      if (fhGws.has(t2.gw)) continue;
      if (t2.out_element !== t.in_element) continue;
      lastOwned = t2.gw - 1;
      break;
    }
    result.set(key, lastOwned);
  }
  return result;
};

// For each transfer (player A out at GW X), determine whether A was
// "started" in the most recent prior non-FH GW where A was in the
// underlying squad. Returns a Set of `${out_element}:${gw}` keys for
// transfers where the OUT side should contribute raw points; transfers
// not in the set get OUT = 0.
//
// Walking back past FH GWs is intentional: a FH GW shows the FH XV (not
// the underlying squad), so the OUT player typically isn't present and
// would erroneously suppress points. Default to "started" when no prior
// owned GW exists (very first GW or always-FH-prior).
const buildPrevStartedSet = (
  realTransfers: ReadonlyArray<TransferRow>,
  multipliers: MultiplierMap,
  finalXv: FinalXvMap,
  fhGws: ReadonlySet<number>,
): Set<string> => {
  const result = new Set<string>();
  for (const t of realTransfers) {
    const key = `${t.out_element}:${t.gw}`;
    let prevMult: number | null = null;
    for (let g = t.gw - 1; g >= 1; g -= 1) {
      if (fhGws.has(g)) continue;
      const xv = finalXv.get(g);
      if (!xv?.has(t.out_element)) continue;
      prevMult = multipliers.get(g)?.get(t.out_element) ?? 0;
      break;
    }
    if (prevMult === null || prevMult > 0) result.add(key);
  }
  return result;
};

// ----------------------------------------------------------------------------
// Public entry point.
// ----------------------------------------------------------------------------

export const getManagerTransfers = async (
  entryId: number,
  startGw: number,
  endGw: number,
): Promise<ManagerTransfersResponse> => {
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
  // `history.chips` lists every chip played with its event GW.
  // `history.current` has per-GW event_transfers_cost.
  type GwMeta = { chip: ActiveChip; hits_cost: number };
  const gwMeta = new Map<number, GwMeta>();
  for (const ev of history.current ?? []) {
    if (ev.event >= startGw && ev.event <= endGw) {
      gwMeta.set(ev.event, {
        chip: null,
        hits_cost: ev.event_transfers_cost ?? 0,
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

  // Identify Free Hit GWs — needed for both the per-pair window logic
  // (FH transfers compare a single GW) and the bench-suppress rule
  // (walk past FH GWs when finding the prev-GW XV).
  const fhGws = new Set<number>();
  for (const [gw, m] of gwMeta) {
    if (m.chip === "freehit") fhGws.add(gw);
  }

  const eventByGw = new Map<number, TransferImpactEvent>();

  // Pre-fetch metadata + history points for every player we'll display.
  const playerIds = new Set<number>();
  for (const t of realTransfers) {
    playerIds.add(t.in_element);
    playerIds.add(t.out_element);
  }
  const minTransferGw =
    realTransfers.length > 0
      ? realTransfers.reduce(
          (acc, t) => (t.gw < acc ? t.gw : acc),
          realTransfers[0]!.gw,
        )
      : startGw;

  const [meta, perRound] = await Promise.all([
    fetchFootballerMeta(Array.from(playerIds)),
    fetchHistoryPointsByRound(Array.from(playerIds), minTransferGw, endGw),
  ]);

  // Compute per-pair windowing once up-front so the inner loop is O(n).
  const lastOwnedGwMap = buildLastOwnedGwMap(realTransfers, fhGws, endGw);
  const prevStarted = buildPrevStartedSet(
    realTransfers,
    multipliers,
    finalXv,
    fhGws,
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
        chip: m?.chip ?? null,
      };
      eventByGw.set(gw, ev);
    }
    return ev;
  };

  for (const t of realTransfers) {
    const isFh = fhGws.has(t.gw);
    const windowEnd = isFh
      ? t.gw
      : (lastOwnedGwMap.get(`${t.in_element}:${t.gw}`) ?? endGw);
    const wasStarted = prevStarted.has(`${t.out_element}:${t.gw}`);

    const inPts = inPointsInWindow(
      perRound,
      multipliers,
      t.in_element,
      t.gw,
      windowEnd,
    );
    const outPts = outPointsInWindow(
      perRound,
      t.out_element,
      t.gw,
      windowEnd,
      wasStarted,
    );
    const pair: TransferImpactPair = {
      player_in: toPlayer(t.in_element, meta.get(t.in_element), inPts),
      player_out: toPlayer(t.out_element, meta.get(t.out_element), outPts),
      net_points: inPts - outPts,
    };
    const ev = ensureEvent(t.gw);
    ev.pairs.push(pair);
    ev.gross_net_points += pair.net_points;
    ev.combined_net_points = ev.gross_net_points - ev.hits_cost;
  }

  // Drop empty events (defensive — only chip-only GWs with no real
  // transfers would land here, and we don't want to surface them).
  for (const [gw, ev] of eventByGw) {
    if (ev.pairs.length === 0) eventByGw.delete(gw);
  }

  const events = Array.from(eventByGw.values()).sort((a, b) => b.gw - a.gw);

  // Headline total: sum of all events' combined_net (gross − hits).
  // BB-only events are gone; BB+transfers events contribute their pair
  // sums minus any hits, identical to non-chip GWs.
  const totalNet = events.reduce((acc, ev) => acc + ev.combined_net_points, 0);
  const transferCount = realTransfers.length;

  return {
    entry_id: entryId,
    start_gw: startGw,
    end_gw: endGw,
    events,
    total_transfers: transferCount,
    total_net_points: totalNet,
    avg_net_per_transfer: transferCount > 0 ? totalNet / transferCount : null,
    incomplete: resolved.incomplete,
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
  const resp = await getManagerTransfers(entryId, startGw, endGw);
  return {
    total_net: resp.total_net_points,
    total_count: resp.total_transfers,
    incomplete: resp.incomplete,
  };
};
