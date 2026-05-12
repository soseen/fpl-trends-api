import { prisma } from "../database/client.js";
import { fetchEntryEventPicks } from "./fetchPicks.js";
import { persistPickElements } from "./persistPickElements.js";
import { delay } from "../utils.js";

// Shared picks resolver for getTeamImpact and getManagerComparison.
//
// Reads what's already persisted in `manager_pick_elements` for the entry
// and (start, end) range, then fetches any missing GWs from the FPL API in
// parallel batches and persists the results. Both endpoints fire in
// parallel from the My Trends frontend on every slider move, so this
// module also keeps an in-flight de-dup map: when comparison and
// team-impact arrive within ~10ms of each other, the second caller awaits
// the first's promise rather than re-issuing 26 FPL fetches.
//
// `manager_pick_elements` has its own DLL-locked-on-Windows-dev quirk so
// we use raw SQL throughout — same approach getTeamImpact already uses.

// Match the batching used by the previous in-place resolvers so we don't
// burst the FPL API harder than the previous comparison/team-impact paths.
const PICKS_BATCH_SIZE = 6;
const INTER_BATCH_DELAY_MS = 60;

export type PickRow = {
  entry_id: number;
  gw: number;
  element_id: number;
  position: number;
  multiplier: number;
  is_captain: boolean;
  is_vice: boolean;
};

export type ResolvedPicks = {
  picks: PickRow[];
  // True if at least one GW in the requested range failed to resolve
  // (FPL fetch error / 404 etc.). Callers surface this as a "best-effort"
  // partial-data flag in the response.
  incomplete: boolean;
};

export const readPersistedPicks = async (
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

// In-flight de-dup. Keyed on (entryId, startGw, endGw) — the natural cache
// granularity for the My Trends panel where comparison and team-impact
// always request the exact same range simultaneously. A lookup that
// matches an existing key returns the same promise, so the FPL fetches
// happen exactly once per range even if both endpoints arrive together.
//
// Entries are deleted on completion (success or failure) so subsequent
// requests with the same key go through normally; the underlying
// `manager_pick_elements` cache is what gives the warm-cache speedup.
const inflight = new Map<string, Promise<ResolvedPicks>>();
const inflightKey = (entryId: number, startGw: number, endGw: number): string =>
  `${entryId}:${startGw}:${endGw}`;

const resolvePicksImpl = async (
  entryId: number,
  finishedGws: number[],
): Promise<ResolvedPicks> => {
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
      await persistPickElements(entryId, r.gw, r.picks);
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
    if (i + PICKS_BATCH_SIZE < missingGws.length)
      await delay(INTER_BATCH_DELAY_MS);
  }

  return { picks: [...persisted, ...fetched], incomplete };
};

// Resolve the user's full XV per GW for every finished GW in the range,
// preferring the `manager_pick_elements` DB cache and falling back to
// FPL for any uncached GWs. Concurrent callers asking for the exact same
// (entryId, startGw, endGw) share a single in-flight promise, so
// comparison and team-impact firing in parallel never double the FPL load.
export const resolvePicks = async (
  entryId: number,
  finishedGws: number[],
): Promise<ResolvedPicks> => {
  if (finishedGws.length === 0) return { picks: [], incomplete: false };
  const key = inflightKey(
    entryId,
    Math.min(...finishedGws),
    Math.max(...finishedGws),
  );

  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = resolvePicksImpl(entryId, finishedGws).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
};

// Captain element + final multiplier per GW, derived from the resolved
// picks. The original is_captain row carries the post-autosub multiplier
// (0/2/3); summarizePicks() in fetchPicks.ts uses the same convention on
// the FPL payload. Returns null entries for GWs that didn't resolve.
export type CaptainPick = {
  gw: number;
  captain_element: number | null;
  captain_multiplier: number | null;
};

export const captainPicksFromResolved = (
  resolved: ResolvedPicks,
  finishedGws: number[],
): CaptainPick[] => {
  const byGw = new Map<number, CaptainPick>();
  for (const gw of finishedGws) {
    byGw.set(gw, { gw, captain_element: null, captain_multiplier: null });
  }
  for (const pick of resolved.picks) {
    if (!pick.is_captain) continue;
    const entry = byGw.get(pick.gw);
    if (!entry) continue;
    entry.captain_element = pick.element_id;
    entry.captain_multiplier = pick.multiplier;
  }
  return Array.from(byGw.values()).sort((a, b) => a.gw - b.gw);
};
