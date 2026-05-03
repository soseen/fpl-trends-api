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
  // Points contributed in the window:
  //   IN side  → multiplier-aware: SUM over [transfer.gw, endGw] of
  //              (pick_multiplier_for_gw × history.total_points_for_gw).
  //              Captures what the player actually did for the user
  //              (benched = 0 contribution; captained = 2× points; etc.).
  //   OUT side → raw: SUM of history.total_points across the window.
  //              Approximates "what we'd have got if we'd kept them" by
  //              assuming a normal start. The user accepted this
  //              approximation because we genuinely can't know whether
  //              a player would have been started/benched/captained.
  points_in_window: number;
};

export type TransferImpactPair = {
  player_in: TransferImpactPlayer;
  player_out: TransferImpactPlayer;
  net_points: number; // in.points_in_window − out.points_in_window
};

// One per GW in which the manager made (kept) transfers, OR played a chip.
// Bench-boost GWs render as a special card: pairs is empty and
// `bench_boost_points` is the headline figure. Chip GWs (wildcard / free
// hit / 3xc / manager) render normally with the chip badge in the header.
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
  // Only set when chip === "bboost". The points scored by the user's
  // bench in this GW; replaces the pair-comparison view because the
  // "what would the previous team's bench have scored" comparison is
  // unfair (BB GWs are always prepared with a strong bench).
  bench_boost_points: number | null;
};

export type ManagerTransfersResponse = {
  entry_id: number;
  start_gw: number;
  end_gw: number;
  events: TransferImpactEvent[]; // sorted by gw desc
  // Number of "real" transfers in range (after ghost filter).
  total_transfers: number;
  // Sum of combined_net_points across events (so hits and bench-boost
  // adjustments are included). The frontend's headline number.
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
// [transfer.gw, endGw]; for GWs where the player isn't in the user's
// squad the multiplier map yields 0 and the contribution is 0
// (matches the "they're no longer ours, can't score for us" semantics
// for transfers-out-of-squad later in the range).
const inPointsInWindow = (
  perRound: Map<string, number>,
  multipliers: MultiplierMap,
  playerId: number,
  fromGw: number,
  endGw: number,
): number => {
  let total = 0;
  for (let gw = fromGw; gw <= endGw; gw += 1) {
    const pts = perRound.get(`${playerId}:${gw}`) ?? 0;
    if (pts === 0) continue;
    const mult = multipliers.get(gw)?.get(playerId) ?? 0;
    total += pts * mult;
  }
  return total;
};

// OUT-player points: raw across the window. Assumes a default multiplier
// of 1 — the user can't truly know whether they'd have started/benched/
// captained the OUT player, and asking the data to guess would be
// misleading. Stays as-is from the v1 implementation.
const outPointsInWindow = (
  perRound: Map<string, number>,
  playerId: number,
  fromGw: number,
  endGw: number,
): number => {
  let total = 0;
  for (let gw = fromGw; gw <= endGw; gw += 1) {
    total += perRound.get(`${playerId}:${gw}`) ?? 0;
  }
  return total;
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

  // Build per-GW chip + hits + bench lookup from the FPL history payload.
  // `history.chips` lists every chip played with its event GW. `history.current`
  // has per-GW points_on_bench and event_transfers_cost.
  type GwMeta = { chip: ActiveChip; hits_cost: number; bench: number };
  const gwMeta = new Map<number, GwMeta>();
  for (const ev of history.current ?? []) {
    if (ev.event >= startGw && ev.event <= endGw) {
      gwMeta.set(ev.event, {
        chip: null,
        hits_cost: ev.event_transfers_cost ?? 0,
        bench: ev.points_on_bench ?? 0,
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

  // Identify bench-boost GWs up-front. We hide pair comparisons for these
  // (the user's spec: "obviously the previous team will have a much worse
  // bench") and surface bench points instead.
  const bbGws = new Set<number>();
  for (const [gw, meta] of gwMeta) {
    if (meta.chip === "bboost") bbGws.add(gw);
  }

  // Build the event list. We iterate every GW that has either real
  // transfers OR a bench-boost (BB events stand alone even with no
  // transfers, because the bench points are still worth showing).
  const eventByGw = new Map<number, TransferImpactEvent>();

  // Pre-fetch metadata + history points for every player we'll display.
  // BB GWs contribute no players, so `playerIds` is built from filtered
  // realTransfers only.
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

  // First, scaffold an event for every GW that needs one (BB or has real
  // transfers). Use a placeholder pairs list; we'll fill in below.
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
        bench_boost_points: null,
      };
      eventByGw.set(gw, ev);
    }
    return ev;
  };

  for (const gw of bbGws) {
    const ev = ensureEvent(gw);
    ev.bench_boost_points = gwMeta.get(gw)?.bench ?? 0;
    // Bench-boost GW: the headline is bench points, not transfer net.
    // Hits cost is dropped on BB GWs by the user's spec — keep it at 0
    // so combined matches the bench number cleanly. (Hits taken on a BB
    // GW are unusual but possible; we deliberately don't muddy the
    // bench-points display with them.)
    ev.hits_cost = 0;
    ev.gross_net_points = 0;
    ev.combined_net_points = ev.bench_boost_points;
  }

  for (const t of realTransfers) {
    if (bbGws.has(t.gw)) continue; // BB GW: no pair comparison
    const inPts = inPointsInWindow(
      perRound,
      multipliers,
      t.in_element,
      t.gw,
      endGw,
    );
    const outPts = outPointsInWindow(perRound, t.out_element, t.gw, endGw);
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

  // Drop scaffolded events that ended up empty (e.g. a non-BB chip GW
  // with no real transfers — shouldn't happen, but defensive).
  for (const [gw, ev] of eventByGw) {
    if (ev.pairs.length === 0 && ev.bench_boost_points === null) {
      eventByGw.delete(gw);
    }
  }

  const events = Array.from(eventByGw.values()).sort((a, b) => b.gw - a.gw);

  // Headline total: sum of all events' combined_net. Includes:
  //   - transfer pair gains/losses (multiplier-aware, ghost-filtered)
  //   - hits subtracted (combined = gross − hits)
  //   - bench-boost bench points (in lieu of pair comparison)
  const totalNet = events.reduce((acc, ev) => acc + ev.combined_net_points, 0);

  // Avg per transfer is a different thing — it's "how good were my
  // swaps". BB events aren't swaps, so they're excluded from both
  // numerator and denominator: dividing chip-bench points by transfer
  // count would give a misleading rate.
  const transferEvents = events.filter((ev) => ev.chip !== "bboost");
  const transferNet = transferEvents.reduce(
    (acc, ev) => acc + ev.combined_net_points,
    0,
  );
  const transferCount = realTransfers.filter((t) => !bbGws.has(t.gw)).length;

  return {
    entry_id: entryId,
    start_gw: startGw,
    end_gw: endGw,
    events,
    total_transfers: transferCount,
    total_net_points: totalNet,
    avg_net_per_transfer:
      transferCount > 0 ? transferNet / transferCount : null,
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
