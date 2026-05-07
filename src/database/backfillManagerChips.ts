import "dotenv/config";
import { fileURLToPath } from "node:url";
import { prisma } from "./client.js";
import { fetchEntryHistory } from "../managers/fetchManager.js";
import {
  rebuildCumulativeForEntry,
  rebuildStratumGwRunningStats,
} from "./populateManagers.js";
import { delay } from "../utils.js";

const readEnvInt = (key: string, fallback: number, min = 1): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  return parsed;
};

const BATCH_SIZE = readEnvInt("MANAGER_CHIP_BACKFILL_BATCH", 8, 1);
const INTER_BATCH_DELAY_MS = readEnvInt(
  "MANAGER_CHIP_BACKFILL_DELAY_MS",
  60,
  0,
);
const MAX_PER_RUN = readEnvInt("MANAGER_CHIP_BACKFILL_MAX", 100_000, 1);

const fetchPendingEntryIds = async (): Promise<number[]> => {
  const rows = await prisma.$queryRawUnsafe<Array<{ entry_id: number }>>(
    `
    SELECT entry_id
    FROM manager_summary
    WHERE has_chip_history = false
    ORDER BY md5(entry_id::text)
    LIMIT $1
    `,
    MAX_PER_RUN,
  );
  return rows.map((r) => r.entry_id);
};

const isStratum = (value: number | null | undefined): value is 1 | 2 | 3 =>
  value === 1 || value === 2 || value === 3;

const persistOne = async (
  entryId: number,
  chips: ReadonlyArray<{ event: number; name: string }>,
): Promise<void> => {
  const summary = await prisma.manager_summary.findUnique({
    where: { entry_id: entryId },
    select: { stratum: true },
  });

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `UPDATE manager_history SET active_chip = NULL WHERE entry_id = $1`,
      entryId,
    );

    if (chips.length > 0) {
      const values: unknown[] = [entryId];
      const tuples = chips.map((chip, i) => {
        const base = i * 2 + 2;
        values.push(chip.event, chip.name);
        return `($${base}::int, $${base + 1}::varchar(20))`;
      });
      await tx.$executeRawUnsafe(
        `
        UPDATE manager_history mh
        SET active_chip = chip_rows.name
        FROM (VALUES ${tuples.join(", ")}) AS chip_rows(gw, name)
        WHERE mh.entry_id = $1
          AND mh.gw = chip_rows.gw
        `,
        ...values,
      );
    }

    await tx.$executeRawUnsafe(
      `UPDATE manager_summary SET has_chip_history = true WHERE entry_id = $1`,
      entryId,
    );
  });

  const stratum = summary?.stratum;
  if (isStratum(stratum)) {
    await rebuildCumulativeForEntry(entryId, stratum);
  }
};

const backfill = async (): Promise<void> => {
  const ids = await fetchPendingEntryIds();
  if (ids.length === 0) {
    console.info("[backfillManagerChips] No managers pending.");
    return;
  }

  console.info(
    `[backfillManagerChips] ${ids.length} managers pending (max per run ${MAX_PER_RUN}, batch ${BATCH_SIZE}, ${INTER_BATCH_DELAY_MS}ms inter-batch).`,
  );

  const startedAt = Date.now();
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (id) => {
        try {
          const history = await fetchEntryHistory(id);
          await persistOne(id, history.chips ?? []);
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
        `[backfillManagerChips] ${succeeded + failed}/${ids.length} processed (${succeeded} ok, ${failed} failed, ${elapsed}s elapsed)`,
      );
    }
    if (i + BATCH_SIZE < ids.length) await delay(INTER_BATCH_DELAY_MS);
  }

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  console.info(
    `[backfillManagerChips] Done. ${succeeded} succeeded, ${failed} failed, ${elapsedSec}s elapsed.`,
  );

  if (succeeded > 0) {
    const rebuildStarted = Date.now();
    await rebuildStratumGwRunningStats();
    console.info(
      `[backfillManagerChips] stratum_gw_running_stats rebuilt in ${Math.round((Date.now() - rebuildStarted) / 1000)}s.`,
    );
  }
};

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await backfill();
  } catch (err) {
    console.error("[backfillManagerChips] Failed:", (err as Error).message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
