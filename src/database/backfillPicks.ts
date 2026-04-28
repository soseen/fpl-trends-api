import "dotenv/config";
import { fileURLToPath } from "node:url";
import { prisma } from "./client.js";
import {
  fetchEntryEventPicks,
  summarizePicks,
} from "../managers/fetchPicks.js";
import {
  DEFAULT_GOVERNOR_CONFIG,
  RateLimitGovernor,
  type GovernorConfig,
} from "../managers/rateLimitGovernor.js";
import { delay } from "../utils.js";

// Long-running backfill of `manager_picks` for every (sampled manager, finished GW)
// pair we don't already have. Idempotent — safe to interrupt and resume.
//
// Designed for the post-deploy bootstrap when the picks table is empty.
// Routine ingestion happens inline in `populateManagers.processEntry`.
//
// Order: stratum 1 (top 10k census) first so the comparison table's
// top-10k column lights up quickly, then stratum 2, then stratum 3.

const BATCH_SIZE = 8;
const MAX_RETRIES = 3;
const PROGRESS_INTERVAL = 500;

const withGovernor = async <T>(
  governor: RateLimitGovernor,
  fn: () => Promise<T>,
): Promise<T> => {
  let attempts = 0;
  for (;;) {
    if (governor.shouldAbort) throw new Error("governor_aborted");
    try {
      const result = await fn();
      governor.noteSuccess();
      return result;
    } catch (err) {
      attempts += 1;
      await governor.noteError(err);
      if (governor.shouldAbort) throw err;
      if (attempts >= MAX_RETRIES) throw err;
    }
  }
};

const getCurrentFinishedGw = async (): Promise<number> => {
  const rows = await prisma.events.findMany({
    where: { finished: true },
    select: { id: true },
    orderBy: { id: "desc" },
    take: 1,
  });
  return rows[0]?.id ?? 0;
};

// Produces the (entry_id, gw) pairs to fetch for one stratum, ordered by
// stratum then gw. Returns missing pairs only — i.e., the ones we don't
// have manager_picks rows for already.
const findMissingPairs = async (
  stratum: 1 | 2 | 3,
  currentGw: number,
): Promise<Array<{ entry_id: number; gw: number }>> => {
  const rows = await prisma.$queryRaw<Array<{ entry_id: number; gw: number }>>`
    WITH gw_series AS (
      SELECT generate_series(1, ${currentGw})::int AS gw
    ),
    candidates AS (
      SELECT ms.entry_id, gw_series.gw
      FROM manager_summary ms
      CROSS JOIN gw_series
      WHERE ms.stratum = ${stratum}
    )
    SELECT c.entry_id, c.gw
    FROM candidates c
    LEFT JOIN manager_picks mp
      ON mp.entry_id = c.entry_id AND mp.gw = c.gw
    WHERE mp.entry_id IS NULL
    ORDER BY c.entry_id, c.gw
  `;
  return rows;
};

const fetchAndStorePicks = async (
  entryId: number,
  gw: number,
  governor: RateLimitGovernor,
): Promise<void> => {
  const payload = await withGovernor(governor, () =>
    fetchEntryEventPicks(entryId, gw),
  );
  const { captain_element, vice_captain_element, captain_multiplier } =
    summarizePicks(payload.picks ?? []);
  await prisma.manager_picks.upsert({
    where: { entry_id_gw: { entry_id: entryId, gw } },
    update: {
      captain_element,
      vice_captain_element,
      captain_multiplier,
      active_chip: payload.active_chip,
    },
    create: {
      entry_id: entryId,
      gw,
      captain_element,
      vice_captain_element,
      captain_multiplier,
      active_chip: payload.active_chip,
    },
  });
};

const ingestStratum = async (
  stratum: 1 | 2 | 3,
  currentGw: number,
  governor: RateLimitGovernor,
): Promise<{ done: number; failed: number }> => {
  const pairs = await findMissingPairs(stratum, currentGw);
  console.info(
    `[backfillPicks] stratum ${stratum}: ${pairs.length} missing (manager, gw) pairs.`,
  );
  let done = 0;
  let failed = 0;
  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    if (governor.shouldAbort) break;
    const batch = pairs.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (pair) => {
        try {
          await fetchAndStorePicks(pair.entry_id, pair.gw, governor);
          done += 1;
        } catch {
          failed += 1;
        }
      }),
    );
    if ((done + failed) % PROGRESS_INTERVAL === 0 && done + failed > 0) {
      console.info(
        `[backfillPicks] stratum ${stratum}: ${done} done, ${failed} failed, ${pairs.length - done - failed} remaining`,
      );
    }
    await delay(governor.interBatchDelayMs);
  }
  console.info(
    `[backfillPicks] stratum ${stratum}: complete (${done} done, ${failed} failed).`,
  );
  return { done, failed };
};

export const backfillPicks = async (
  governorConfig?: Partial<GovernorConfig>,
): Promise<void> => {
  const governor = new RateLimitGovernor(
    governorConfig
      ? { ...DEFAULT_GOVERNOR_CONFIG, ...governorConfig }
      : undefined,
  );

  const currentGw = await getCurrentFinishedGw();
  if (currentGw < 1) {
    console.warn("[backfillPicks] No finished GWs yet — nothing to backfill.");
    return;
  }

  let totalDone = 0;
  let totalFailed = 0;
  for (const stratum of [1, 2, 3] as const) {
    if (governor.shouldAbort) break;
    const result = await ingestStratum(stratum, currentGw, governor);
    totalDone += result.done;
    totalFailed += result.failed;
  }
  console.info(
    `[backfillPicks] all strata complete: ${totalDone} done, ${totalFailed} failed (governor aborted: ${governor.shouldAbort}).`,
  );
};

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await backfillPicks();
  } finally {
    await prisma.$disconnect();
  }
}
