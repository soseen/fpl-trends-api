import "dotenv/config";
import { fileURLToPath } from "node:url";
import { prisma } from "./client.js";
import {
  fetchEntryEventPicks,
  summarizePicks,
} from "../managers/fetchPicks.js";
import { persistPickElements } from "../managers/persistPickElements.js";
import {
  DEFAULT_GOVERNOR_CONFIG,
  RateLimitGovernor,
  type GovernorConfig,
} from "../managers/rateLimitGovernor.js";
import {
  rebuildRankBandPlayerExposure,
  rebuildStratumCaptainPicks,
} from "./populateManagers.js";
import { delay } from "../utils.js";

const readEnvInt = (key: string, fallback: number, min = 1): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  return parsed;
};

const TARGET_BY_STRATUM: Record<1 | 2 | 3, number> = {
  1: readEnvInt("MANAGER_COMPARISON_PICKS_TARGET_S1", 2_000, 250),
  2: readEnvInt("MANAGER_COMPARISON_PICKS_TARGET_S2", 4_000, 250),
  3: readEnvInt("MANAGER_COMPARISON_PICKS_TARGET_S3", 4_000, 250),
};
const BATCH_SIZE = readEnvInt("MANAGER_COMPARISON_PICKS_BATCH", 8, 1);
const MAX_RETRIES = readEnvInt("MANAGER_COMPARISON_PICKS_RETRIES", 3, 1);
const PROGRESS_INTERVAL = readEnvInt(
  "MANAGER_COMPARISON_PICKS_PROGRESS",
  1_000,
  100,
);

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
      if (governor.shouldAbort || attempts >= MAX_RETRIES) throw err;
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

const findMissingPairs = async (
  stratum: 1 | 2 | 3,
  currentGw: number,
  targetManagers: number,
): Promise<Array<{ entry_id: number; gw: number }>> => {
  const rows = await prisma.$queryRaw<Array<{ entry_id: number; gw: number }>>`
    WITH chosen_managers AS (
      SELECT ms.entry_id
      FROM manager_summary ms
      WHERE ms.stratum = ${stratum}
      ORDER BY md5(ms.entry_id::text)
      LIMIT ${targetManagers}
    ),
    gw_series AS (
      SELECT generate_series(1, ${currentGw})::int AS gw
    ),
    candidates AS (
      SELECT cm.entry_id, gw_series.gw
      FROM chosen_managers cm
      CROSS JOIN gw_series
    )
    SELECT c.entry_id, c.gw
    FROM candidates c
    LEFT JOIN manager_picks mp
      ON mp.entry_id = c.entry_id AND mp.gw = c.gw
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS pick_elements
      FROM manager_pick_elements mpe
      WHERE mpe.entry_id = c.entry_id AND mpe.gw = c.gw
    ) mpe ON true
    WHERE mp.entry_id IS NULL
       OR COALESCE(mpe.pick_elements, 0) < 15
    ORDER BY c.entry_id, c.gw
  `;
  return rows;
};

const isHttpStatus = (err: unknown, status: number): boolean => {
  if (typeof err !== "object" || err === null || !("response" in err)) {
    return false;
  }
  const response = (err as { response?: { status?: number } }).response;
  return response?.status === status;
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
  await persistPickElements(entryId, gw, payload.picks ?? []);
};

const ingestStratum = async (
  stratum: 1 | 2 | 3,
  currentGw: number,
  governor: RateLimitGovernor,
): Promise<{ done: number; failed: number; skipped: number }> => {
  const targetManagers = TARGET_BY_STRATUM[stratum];
  const pairs = await findMissingPairs(stratum, currentGw, targetManagers);
  console.info(
    `[backfillComparisonPicks] stratum ${stratum}: target ${targetManagers} managers, ${pairs.length} missing (manager, gw) pairs.`,
  );

  let done = 0;
  let failed = 0;
  let skipped = 0;
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
      done + failed + skipped > 0
    ) {
      console.info(
        `[backfillComparisonPicks] stratum ${stratum}: ${done} done, ${failed} failed, ${skipped} skipped, ${pairs.length - done - failed - skipped} remaining`,
      );
    }
    await delay(governor.interBatchDelayMs);
  }

  console.info(
    `[backfillComparisonPicks] stratum ${stratum}: complete (${done} done, ${failed} failed, ${skipped} skipped).`,
  );
  return { done, failed, skipped };
};

export const backfillComparisonPicks = async (
  governorConfig?: Partial<GovernorConfig>,
): Promise<void> => {
  const currentGw = await getCurrentFinishedGw();
  if (currentGw < 1) {
    console.warn(
      "[backfillComparisonPicks] No finished GWs yet; nothing to backfill.",
    );
    return;
  }

  const governor = new RateLimitGovernor(
    governorConfig
      ? { ...DEFAULT_GOVERNOR_CONFIG, ...governorConfig }
      : undefined,
  );

  const startedAt = Date.now();
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

  const rebuildStarted = Date.now();
  await rebuildStratumCaptainPicks();
  console.info(
    `[backfillComparisonPicks] captain pick read model rebuilt in ${Math.round((Date.now() - rebuildStarted) / 1000)}s.`,
  );

  const exposureStarted = Date.now();
  await rebuildRankBandPlayerExposure();
  console.info(
    `[backfillComparisonPicks] player exposure read model rebuilt in ${Math.round((Date.now() - exposureStarted) / 1000)}s.`,
  );

  console.info(
    `[backfillComparisonPicks] complete: ${totalDone} done, ${totalFailed} failed, ${totalSkipped} skipped, governor aborted ${governor.shouldAbort}, ${Math.round((Date.now() - startedAt) / 1000)}s elapsed.`,
  );
};

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await backfillComparisonPicks({ abortAfterConsecutiveErrors: 20 });
  } finally {
    await prisma.$disconnect();
  }
}
