import "dotenv/config";
import { fileURLToPath } from "node:url";
import { prisma } from "./client.js";
import { fetchEntryHistory } from "../managers/fetchManager.js";
import { delay } from "../utils.js";
import { rebuildRankBandPlayerExposure } from "./populateManagers.js";

const readEnvInt = (key: string, fallback: number, min = 1): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  return parsed;
};

const BATCH_SIZE = readEnvInt("MANAGER_RANK_BACKFILL_BATCH", 8, 1);
const INTER_BATCH_DELAY_MS = readEnvInt(
  "MANAGER_RANK_BACKFILL_DELAY_MS",
  60,
  0,
);
const MAX_PER_RUN = readEnvInt("MANAGER_RANK_BACKFILL_MAX", 100_000, 1);

const fetchPendingEntryIds = async (): Promise<number[]> => {
  const rows = await prisma.$queryRawUnsafe<Array<{ entry_id: number }>>(
    `
    SELECT ms.entry_id
    FROM manager_summary ms
    WHERE EXISTS (
      SELECT 1
      FROM manager_history mh
      WHERE mh.entry_id = ms.entry_id
        AND mh.overall_rank IS NULL
    )
      AND EXISTS (
        SELECT 1
        FROM manager_pick_elements mpe
        WHERE mpe.entry_id = ms.entry_id
      )
    ORDER BY md5(ms.entry_id::text)
    LIMIT $1
    `,
    MAX_PER_RUN,
  );
  return rows.map(({ entry_id }) => entry_id);
};

const persistRanks = async (
  entryId: number,
  events: ReadonlyArray<{ event: number; overall_rank: number }>,
): Promise<void> => {
  await prisma.$transaction(
    events.map((event) =>
      prisma.manager_history.updateMany({
        where: { entry_id: entryId, gw: event.event },
        data: { overall_rank: event.overall_rank },
      }),
    ),
  );
};

export const backfillManagerRanks = async (): Promise<void> => {
  const ids = await fetchPendingEntryIds();
  if (ids.length === 0) {
    console.info("[backfillManagerRanks] No managers pending.");
    return;
  }

  console.info(
    `[backfillManagerRanks] ${ids.length} managers pending (max per run ${MAX_PER_RUN}, batch ${BATCH_SIZE}, ${INTER_BATCH_DELAY_MS}ms inter-batch).`,
  );

  const startedAt = Date.now();
  let succeeded = 0;
  let failed = 0;
  for (let index = 0; index < ids.length; index += BATCH_SIZE) {
    const batch = ids.slice(index, index + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (entryId) => {
        try {
          const history = await fetchEntryHistory(entryId);
          await persistRanks(entryId, history.current ?? []);
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

    if ((index / BATCH_SIZE) % 25 === 0) {
      console.info(
        `[backfillManagerRanks] ${succeeded + failed}/${ids.length} processed (${succeeded} ok, ${failed} failed).`,
      );
    }
    if (index + BATCH_SIZE < ids.length) await delay(INTER_BATCH_DELAY_MS);
  }

  console.info(
    `[backfillManagerRanks] Done. ${succeeded} succeeded, ${failed} failed, ${Math.round((Date.now() - startedAt) / 1000)}s elapsed.`,
  );

  if (succeeded > 0) {
    const rebuildStarted = Date.now();
    await rebuildRankBandPlayerExposure();
    console.info(
      `[backfillManagerRanks] player exposure read model rebuilt in ${Math.round((Date.now() - rebuildStarted) / 1000)}s.`,
    );
  }
};

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await backfillManagerRanks();
  } catch (error) {
    console.error("[backfillManagerRanks] Failed:", (error as Error).message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
