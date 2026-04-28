import "dotenv/config";
import { fileURLToPath } from "node:url";
import { prisma } from "./client.js";
import { fetchEntryHistory } from "../managers/fetchManager.js";
import { netPointsForEvent } from "../managers/activityFilter.js";
import {
  DEFAULT_GOVERNOR_CONFIG,
  RateLimitGovernor,
  type GovernorConfig,
} from "../managers/rateLimitGovernor.js";
import { delay } from "../utils.js";

// One-off backfill for managers classified as inactive/trolling whose
// per-GW history was deleted by the pre-fix populate logic. Re-fetches
// /entry/{id}/history/ and writes manager_history rows so the rank
// extrapolation can count their real early-GW scores.
//
// Idempotent — selects only entries with zero existing manager_history
// rows. Safe to re-run after interruption.

const BATCH_SIZE = 8;
const MAX_RETRIES = 3;

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

const findCandidates = async (): Promise<number[]> => {
  // Inactive/trolling managers with no history rows at all.
  const rows = await prisma.$queryRaw<Array<{ entry_id: number }>>`
    SELECT ms.entry_id
    FROM manager_summary ms
    LEFT JOIN manager_history mh ON mh.entry_id = ms.entry_id
    WHERE ms.rejected_reason IN ('inactive', 'trolling')
    GROUP BY ms.entry_id
    HAVING COUNT(mh.entry_id) = 0
    ORDER BY ms.entry_id
  `;
  return rows.map((r) => r.entry_id);
};

const writeHistory = async (entryId: number, governor: RateLimitGovernor) => {
  const history = await withGovernor(governor, () =>
    fetchEntryHistory(entryId),
  );
  for (const ev of history.current ?? []) {
    await prisma.manager_history.upsert({
      where: { entry_id_gw: { entry_id: entryId, gw: ev.event } },
      update: {
        points: netPointsForEvent(ev),
        event_transfers_cost: ev.event_transfers_cost,
        points_on_bench: ev.points_on_bench,
      },
      create: {
        entry_id: entryId,
        gw: ev.event,
        points: netPointsForEvent(ev),
        event_transfers_cost: ev.event_transfers_cost,
        points_on_bench: ev.points_on_bench,
      },
    });
  }
};

export const backfillNonActiveHistory = async (
  governorConfig?: Partial<GovernorConfig>,
): Promise<void> => {
  const governor = new RateLimitGovernor(
    governorConfig
      ? { ...DEFAULT_GOVERNOR_CONFIG, ...governorConfig }
      : undefined,
  );

  const candidates = await findCandidates();
  console.info(
    `[backfillNonActiveHistory] ${candidates.length} managers need history backfill.`,
  );
  if (candidates.length === 0) return;

  let done = 0;
  let failed = 0;
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    if (governor.shouldAbort) break;
    const batch = candidates.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (id) => {
        try {
          await writeHistory(id, governor);
          done += 1;
        } catch {
          failed += 1;
        }
      }),
    );
    if ((done + failed) % 200 === 0) {
      console.info(
        `[backfillNonActiveHistory] progress: ${done} done, ${failed} failed, ${candidates.length - done - failed} remaining`,
      );
    }
    await delay(governor.interBatchDelayMs);
  }

  console.info(
    `[backfillNonActiveHistory] complete: ${done} succeeded, ${failed} failed.`,
  );
};

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await backfillNonActiveHistory();
  } finally {
    await prisma.$disconnect();
  }
}
