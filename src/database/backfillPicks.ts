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
//
// `rejected_reason IS NULL` filters out fetch_failed / inactive / trolling
// managers. fetch_failed entry_ids are gone from FPL (banned/deleted) and
// will return 404 forever — repeatedly hitting them used to trip the
// governor's consecutive-error abort. Inactive/trolling picks aren't used
// by any comparison query (those filter on the same flag), so backfilling
// them is wasted FPL traffic.
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
        AND ms.rejected_reason IS NULL
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

const isHttpStatus = (err: unknown, status: number): boolean => {
  if (typeof err !== "object" || err === null || !("response" in err)) {
    return false;
  }
  const r = (err as { response?: { status?: number } }).response;
  return r?.status === status;
};

const fetchAndStorePicks = async (
  entryId: number,
  gw: number,
  governor: RateLimitGovernor,
): Promise<void> => {
  let payload;
  try {
    payload = await withGovernor(governor, () =>
      fetchEntryEventPicks(entryId, gw),
    );
  } catch (err) {
    // 404 = manager deleted / banned by FPL since we last sampled them.
    // Tag them in manager_summary so the next backfill run's
    // `findMissingPairs` filter (rejected_reason IS NULL) excludes them
    // — otherwise we'd burn API calls on the same dead entries forever.
    // The flag is set per-entry, not per-(entry,gw): one 404 implies
    // the whole account is gone, so all remaining (entry, gw) pairs
    // for them are wasted.
    if (isHttpStatus(err, 404)) {
      await prisma.manager_summary.update({
        where: { entry_id: entryId },
        data: { rejected_reason: "fetch_failed" },
      });
    }
    throw err;
  }
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
): Promise<{ done: number; failed: number; skipped: number }> => {
  const pairs = await findMissingPairs(stratum, currentGw);
  console.info(
    `[backfillPicks] stratum ${stratum}: ${pairs.length} missing (manager, gw) pairs.`,
  );
  let done = 0;
  let failed = 0;
  let skipped = 0;
  // An entry that 404s on any of its GWs is dead at FPL's end (deleted /
  // banned). It's already been tagged `fetch_failed` in DB by
  // fetchAndStorePicks for the next run, but the rest of THIS run's
  // pairs for that entry are still in the in-memory `pairs` array.
  // Track them in this set so we skip them without a network call.
  const deadEntries = new Set<number>();
  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    if (governor.shouldAbort) break;
    const batch = pairs.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (pair) => {
        if (deadEntries.has(pair.entry_id)) {
          skipped += 1;
          return;
        }
        try {
          await fetchAndStorePicks(pair.entry_id, pair.gw, governor);
          done += 1;
        } catch (err) {
          failed += 1;
          if (isHttpStatus(err, 404)) deadEntries.add(pair.entry_id);
        }
      }),
    );
    if (
      (done + failed + skipped) % PROGRESS_INTERVAL === 0 &&
      done + failed > 0
    ) {
      console.info(
        `[backfillPicks] stratum ${stratum}: ${done} done, ${failed} failed, ${skipped} skipped (dead entry), ${pairs.length - done - failed - skipped} remaining`,
      );
    }
    await delay(governor.interBatchDelayMs);
  }
  console.info(
    `[backfillPicks] stratum ${stratum}: complete (${done} done, ${failed} failed, ${skipped} skipped).`,
  );
  return { done, failed, skipped };
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
  let totalSkipped = 0;
  for (const stratum of [1, 2, 3] as const) {
    if (governor.shouldAbort) break;
    const result = await ingestStratum(stratum, currentGw, governor);
    totalDone += result.done;
    totalFailed += result.failed;
    totalSkipped += result.skipped;
  }
  console.info(
    `[backfillPicks] all strata complete: ${totalDone} done, ${totalFailed} failed, ${totalSkipped} skipped (governor aborted: ${governor.shouldAbort}).`,
  );
};

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    // Looser abort threshold than the cron default. The backfill churns
    // through millions of pairs; a stretch of unrelated 404s or transient
    // network errors on the FPL side shouldn't kill an hours-long run.
    // 429s and 503s still trigger the 5-minute pause via the governor —
    // this only widens the bucket for "unknown" errors before it gives up.
    await backfillPicks({ abortAfterConsecutiveErrors: 20 });
  } finally {
    await prisma.$disconnect();
  }
}
