import { transfersSchema } from "./sourceValidation.js";
import { ZodError } from "zod";
import { AnalyticsError, errorInfo } from "../analytics/errors.js";
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

const resolveImpl = async (entryId: number): Promise<ResolvedTransfers> => {
  const season = await prisma.app_metadata.findUnique({
    where: { key: "current_season" },
  });
  const sources = season
    ? await prisma.$queryRaw<
        Array<{ payload: unknown; fetched_at: Date }>
      >`SELECT payload,fetched_at FROM analytics_manager_sources WHERE season=${season.value} AND entry_id=${entryId} AND kind='transfers'`
    : [];
  const source = sources[0];
  const normalized = (value: unknown): TransferRow[] =>
    transfersSchema
      .parse(value)
      .sort(
        (a, b) =>
          a.event - b.event || (a.time ?? " ").localeCompare(b.time ?? " "),
      )
      .map((t) => ({
        entry_id: entryId,
        gw: t.event,
        in_element: t.element_in,
        out_element: t.element_out,
        in_cost: t.element_in_cost,
        out_cost: t.element_out_cost,
      }));
  const persisted = source
    ? normalized(source.payload)
    : await readPersisted(entryId);
  if (source && Date.now() - source.fetched_at.getTime() < 60_000)
    return { rows: persisted, incomplete: false };

  let fetched: FplTransfer[];
  try {
    fetched = await fetchEntryTransfers(entryId);
    if (fetched.some((t) => t.entry !== entryId))
      throw new AnalyticsError(
        "identity_mismatch",
        "FPL returned transfers for a different manager.",
        false,
      );
    // FPL returns newest first. Preserve repeated same-GW operations in the
    // authoritative source snapshot; the old relational key can merge them.
    fetched = [...fetched]
      .reverse()
      .sort(
        (a, b) =>
          a.event - b.event || (a.time ?? "").localeCompare(b.time ?? ""),
      );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "analytics_transfer_fetch_failed",
        ...errorInfo(error),
      }),
    );
    if (error instanceof ZodError || error instanceof AnalyticsError)
      throw error;
    // FPL fetch failed; serve whatever we have on disk and flag the
    // response as incomplete. Don't mark has_transfer_history so the
    // next visit retries.
    return { rows: persisted, incomplete: true };
  }

  if (season)
    await prisma.$executeRaw`INSERT INTO analytics_manager_sources(season,entry_id,kind,payload) VALUES (${season.value},${entryId},'transfers',${JSON.stringify(fetched)}::jsonb) ON CONFLICT(season,entry_id,kind) DO UPDATE SET payload=excluded.payload,fetched_at=now()`;
  await persist(entryId, fetched);
  await setHasTransferHistory(entryId, true);

  return { rows: normalized(fetched), incomplete: false };
};

// Worker sections share one in-flight fetch and a validated 60-second source
// snapshot. Repeated transfer operations are preserved in chronological order.
export const resolveTransfers = async (
  entryId: number,
): Promise<ResolvedTransfers> => {
  const existing = inflight.get(entryId);
  if (existing) return existing;

  const promise = resolveImpl(entryId).finally(() => {
    inflight.delete(entryId);
  });
  inflight.set(entryId, promise);
  return promise;
};
