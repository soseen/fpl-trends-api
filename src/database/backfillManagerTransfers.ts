import "dotenv/config";
import { fileURLToPath } from "node:url";
import { prisma } from "./client.js";
import { fetchEntryTransfers } from "../managers/fetchTransfers.js";
import { delay } from "../utils.js";

// One-off backfill of manager_transfers across the full sampled population.
// Idempotent (ON CONFLICT … DO NOTHING) so safe to interrupt and rerun.
//
// After this lands, populateManagers.ingestTransfersForEntry maintains the
// table on every visit (gated by has_transfer_history). This script only
// matters for the initial bootstrap of the production table from the
// existing ~625k-manager sample.
//
// Strategy: walk all managers where has_transfer_history = false, fetch
// their transfers from FPL, batch upsert. One HTTP call per manager (the
// /entry/{id}/transfers/ endpoint returns the manager's full season at
// once). Mirrors the batching cadence of populateManagers (8 in flight,
// 60ms inter-batch delay) so we don't burst the FPL API.

const readEnvInt = (key: string, fallback: number, min = 1): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  return parsed;
};

const BATCH_SIZE = readEnvInt("MANAGER_TRANSFER_BACKFILL_BATCH", 8, 1);
const INTER_BATCH_DELAY_MS = readEnvInt(
  "MANAGER_TRANSFER_BACKFILL_DELAY_MS",
  60,
  0,
);
// Cap per run so a single invocation can't exhaust the FPL goodwill or
// hold the connection pool indefinitely. Re-run until the underlying
// query returns zero managers.
const MAX_PER_RUN = readEnvInt("MANAGER_TRANSFER_BACKFILL_MAX", 100_000, 1);

const fetchPendingEntryIds = async (): Promise<number[]> => {
  const rows = await prisma.$queryRawUnsafe<Array<{ entry_id: number }>>(
    `
    SELECT entry_id
    FROM manager_summary
    WHERE has_transfer_history = false
    ORDER BY md5(entry_id::text)
    LIMIT $1
    `,
    MAX_PER_RUN,
  );
  return rows.map((r) => r.entry_id);
};

const persistOne = async (
  entryId: number,
  transfers: ReadonlyArray<{
    element_in: number;
    element_in_cost: number;
    element_out: number;
    element_out_cost: number;
    event: number;
  }>,
): Promise<void> => {
  if (transfers.length > 0) {
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
  }
  await prisma.$executeRawUnsafe(
    `UPDATE manager_summary SET has_transfer_history = true WHERE entry_id = $1`,
    entryId,
  );
};

const backfill = async (): Promise<void> => {
  const ids = await fetchPendingEntryIds();
  if (ids.length === 0) {
    console.info(
      "[backfillManagerTransfers] No managers pending — nothing to do.",
    );
    return;
  }

  console.info(
    `[backfillManagerTransfers] ${ids.length} managers pending (max per run ${MAX_PER_RUN}, batch ${BATCH_SIZE}, ${INTER_BATCH_DELAY_MS}ms inter-batch).`,
  );

  const startedAt = Date.now();
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (id) => {
        try {
          const transfers = await fetchEntryTransfers(id);
          await persistOne(id, transfers);
          return true;
        } catch {
          return false;
        }
      }),
    );
    for (const ok of results) {
      if (ok) succeeded += 1;
      else failed += 1;
    }
    if ((i / BATCH_SIZE) % 25 === 0) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.info(
        `[backfillManagerTransfers] ${succeeded + failed}/${ids.length} processed (${succeeded} ok, ${failed} failed, ${elapsed}s elapsed)`,
      );
    }
    if (i + BATCH_SIZE < ids.length) await delay(INTER_BATCH_DELAY_MS);
  }

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  console.info(
    `[backfillManagerTransfers] Done. ${succeeded} succeeded, ${failed} failed, ${elapsedSec}s elapsed.`,
  );
};

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await backfill();
  } catch (err) {
    console.error("[backfillManagerTransfers] Failed:", (err as Error).message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
