import { prisma } from "../database/client.js";
import { fetchEntryTransfers, type FplTransfer } from "./fetchTransfers.js";

// Lazy resolver for one manager's full transfer history. Mirrors the shape
// of resolvePicks.ts:
//   - reads what's already persisted in `manager_transfers` for the entry
//   - falls back to a single FPL fetch if the row is empty AND the manager
//     hasn't been marked has_transfer_history yet
//   - upserts the result
//   - dedups concurrent in-flight calls by entry id (so the /transfers and
//     /comparison endpoints firing in parallel from My Trends share one
//     FPL call rather than two)
//
// Unlike picks, the entire transfer history is one HTTP call (FPL returns
// the manager's full season at once). No batching needed.

export type TransferRow = {
  entry_id: number;
  gw: number;
  in_element: number;
  out_element: number;
  in_cost: number;
  out_cost: number;
};

export type ResolvedTransfers = {
  rows: TransferRow[];
  // True if the FPL fetch failed; the persisted rows (if any) are still
  // returned so the endpoint can serve a best-effort response.
  incomplete: boolean;
};

const readPersisted = async (entryId: number): Promise<TransferRow[]> => {
  return prisma.$queryRawUnsafe<TransferRow[]>(
    `
    SELECT entry_id, gw, in_element, out_element, in_cost, out_cost
    FROM manager_transfers
    WHERE entry_id = $1
    ORDER BY gw ASC
    `,
    entryId,
  );
};

const persist = async (
  entryId: number,
  transfers: ReadonlyArray<FplTransfer>,
): Promise<void> => {
  if (transfers.length === 0) return;
  const values: unknown[] = [];
  const tuples = transfers.map((t, i) => {
    const base = i * 6;
    values.push(
      entryId,
      t.event,
      t.element_in,
      t.element_out,
      t.element_in_cost,
      t.element_out_cost,
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
  });
  await prisma.$executeRawUnsafe(
    `
    INSERT INTO manager_transfers
      (entry_id, gw, in_element, out_element, in_cost, out_cost)
    VALUES ${tuples.join(", ")}
    ON CONFLICT (entry_id, gw, in_element, out_element) DO NOTHING
    `,
    ...values,
  );
};

const setHasTransferHistory = async (
  entryId: number,
  has: boolean,
): Promise<void> => {
  // Manager may not exist in manager_summary yet (a brand-new user looking
  // up their own ID before populate has visited them). UPDATE-with-no-row
  // is a no-op, which is what we want — once they're ingested the flag
  // gets set on their first populate visit anyway.
  await prisma.$executeRawUnsafe(
    `UPDATE manager_summary SET has_transfer_history = $2 WHERE entry_id = $1`,
    entryId,
    has,
  );
};

const inflight = new Map<number, Promise<ResolvedTransfers>>();

const resolveImpl = async (
  entryId: number,
  forceRefetch: boolean,
): Promise<ResolvedTransfers> => {
  const persisted = await readPersisted(entryId);

  // Fast path: if we already have rows AND the user isn't asking us to
  // refetch, trust what's stored. The transfer log only grows over time
  // (FPL never deletes past transfers), so the persisted view is
  // monotonically a prefix of the live one — only stale by at most the
  // populate cron cadence for sampled managers, or the user's most
  // recent transfer for arbitrary IDs.
  if (persisted.length > 0 && !forceRefetch) {
    return { rows: persisted, incomplete: false };
  }

  let fetched: FplTransfer[];
  try {
    fetched = await fetchEntryTransfers(entryId);
  } catch {
    // FPL fetch failed; serve whatever we have on disk and flag the
    // response as incomplete. Don't mark has_transfer_history so the
    // next visit retries.
    return { rows: persisted, incomplete: true };
  }

  await persist(entryId, fetched);
  await setHasTransferHistory(entryId, true);

  // Re-read so the response order matches the on-disk view (gw asc) and
  // includes any rows persisted by a parallel resolver while we were
  // awaiting the FPL call.
  const rows = await readPersisted(entryId);
  return { rows, incomplete: false };
};

// Resolve the manager's full transfer history. Concurrent callers asking
// for the same entryId share one in-flight promise — the /transfers and
// /comparison endpoints firing from My Trends in parallel never double
// the FPL load.
//
// `forceRefetch=true` skips the persisted-row fast path. Used by the
// per-user /transfers endpoint to ensure the user always sees their
// latest transfer reflected on the page (fresh user IDs that aren't in
// the sample yet wouldn't otherwise get a refetch).
export const resolveTransfers = async (
  entryId: number,
  forceRefetch = false,
): Promise<ResolvedTransfers> => {
  const existing = inflight.get(entryId);
  if (existing) return existing;

  const promise = resolveImpl(entryId, forceRefetch).finally(() => {
    inflight.delete(entryId);
  });
  inflight.set(entryId, promise);
  return promise;
};
