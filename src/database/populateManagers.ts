import "dotenv/config";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "node:url";
import { prisma } from "./client.js";
import {
  fetchEntryHistory,
  fetchLeagueStandingsPage,
  OVERALL_LEAGUE_ID,
} from "../managers/fetchManager.js";
import {
  classifyManager,
  netPointsForEvent,
} from "../managers/activityFilter.js";
import {
  fetchEntryEventPicks,
  summarizePicks,
} from "../managers/fetchPicks.js";
import {
  RateLimitGovernor,
  DEFAULT_GOVERNOR_CONFIG,
  type GovernorConfig,
} from "../managers/rateLimitGovernor.js";
import { delay } from "../utils.js";

// Stratum A: full census of the top 10k. 200 pages × 50 entries.
const STRATUM_A_LAST_PAGE = 200;
// Stratum B: pages 201–2000. Stride 1 = full census of the 10k–100k cohort
// (~90k entries per pass). Critically, stride 1 also keeps stratum tags
// fresh: any manager whose rank has crossed back into the top 100k (i.e.,
// improved out of stratum 3) gets re-tagged on its next pass. Strides > 1
// skipped half (or more) of S2 pages, leaving "improvement movers" stuck
// in our DB tagged stratum=3 with high cumulative scores — that drove a
// ~14% over-count on stratum-3 rank queries.
const STRATUM_B_FIRST_PAGE = 201;
const STRATUM_B_LAST_PAGE = 2000;
const STRATUM_B_PAGE_STRIDE = 1;
// Stratum C: systematic 1-in-20 walk over the FPL standings tail. Each page
// has 50 entries; stride 20 means we sample 50 of every 1000 ranked
// managers, giving ~625k unique probes per pass over a 12.6M-ranked tail.
//
// We deliberately moved away from random-entry-ID probing here: random IDs
// over-sampled engaged returning users (low IDs 1..3M) and undersampled
// recent joiners (high IDs 10M+), which biased the rank-rank estimate by
// ~12% even with very large samples. The standings page is FPL's own
// ranking, which is exactly the population we want to extrapolate from —
// so a systematic walk is unbiased by construction.
//
// LAST_PAGE 252_000 covers ranks up to 12.6M, comfortably above the
// largest observed `events.ranked_count`. Pages past the live tail return
// an empty `standings.results` array, which `ingestFromStandings` handles
// gracefully (page advances, nothing recorded).
const STRATUM_C_FIRST_PAGE = 2001;
const STRATUM_C_LAST_PAGE = 252_000;
const STRATUM_C_PAGE_STRIDE = 20;

// Per-run safety cap. Cron fires every 15 min; at ~25 req/s sustained this
// is ~13 min of work per run, leaving slack for governor backoffs and
// preventing overlap with the next cron.
const MAX_MANAGERS_PER_RUN = 20000;

// Budget split when stratum A is still in progress vs done. A is the top
// 10k (fixed). B with stride 1 has 1800 pages = 90k entries to cover
// per pass; at 5000/cron that's a full pass every ~4.5 hours, fast enough
// to keep stratum tags reasonably fresh. C still gets the largest share
// (extrapolation factor is biggest and new probes are most likely unseen).
const BUDGET_A_WHILE_RUNNING = 2000;
const BUDGET_B_WHILE_RUNNING = 5000;

// Concurrency within each batch. Combined with the governor's inter-batch
// delay (default 300 ms) this gives ~25 req/s sustained.
const HISTORY_BATCH_SIZE = 8;

const CURSOR_KEY_A = "manager_ingest_cursor_a";
const CURSOR_KEY_B = "manager_ingest_cursor_b";
const CURSOR_KEY_C = "manager_ingest_cursor_c";
const LOCKFILE_PATH = path.join(os.tmpdir(), "fpl-populate-managers.lock");
// Conservative max age — a normal run is ~13 min; anything older than this
// can only mean the previous owner died without releasing.
const LOCK_MAX_AGE_MS = 30 * 60 * 1000;

const releaseLock = (): void => {
  try {
    fs.unlinkSync(LOCKFILE_PATH);
  } catch {
    /* ignore */
  }
};

let cleanupRegistered = false;
const registerLockCleanupHandlers = (): void => {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.on("exit", releaseLock);
  // Signal handlers must call exit explicitly — registering them suppresses
  // Node's default-terminate behavior. Conventional exit codes are 128+signum.
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));
};

const isLockStale = (): boolean => {
  let contents: string;
  try {
    contents = fs.readFileSync(LOCKFILE_PATH, "utf8");
  } catch {
    return false;
  }

  const pid = parseInt(contents.trim(), 10);
  if (Number.isFinite(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      return false;
    } catch (err) {
      // ESRCH = process is gone. EPERM = exists but owned by another user
      // (alive on this host) — leave it alone.
      return (err as NodeJS.ErrnoException).code === "ESRCH";
    }
  }

  // PID unparseable — fall back to mtime so a corrupt lockfile can still
  // self-heal once it's well past any plausible run length.
  try {
    const stat = fs.statSync(LOCKFILE_PATH);
    return Date.now() - stat.mtimeMs > LOCK_MAX_AGE_MS;
  } catch {
    return false;
  }
};

const acquireLock = (): boolean => {
  try {
    fs.writeFileSync(LOCKFILE_PATH, String(process.pid), { flag: "wx" });
    registerLockCleanupHandlers();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
  }

  if (!isLockStale()) return false;

  console.warn(
    "[populateManagers] Found stale lockfile — previous owner is gone, clearing and retrying.",
  );
  try {
    fs.unlinkSync(LOCKFILE_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }

  try {
    fs.writeFileSync(LOCKFILE_PATH, String(process.pid), { flag: "wx" });
    registerLockCleanupHandlers();
    return true;
  } catch {
    return false;
  }
};

const readIntCursor = async (
  key: string,
  fallback: number,
): Promise<number> => {
  const rows = await prisma.$queryRaw<Array<{ value: string }>>`
    SELECT value FROM app_metadata WHERE key = ${key}
  `;
  const v = rows[0]?.value;
  if (!v) return fallback;
  const parsed = parseInt(v, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const writeIntCursor = async (key: string, value: number): Promise<void> => {
  const v = String(value);
  await prisma.$executeRaw`
    INSERT INTO app_metadata (key, value)
    VALUES (${key}, ${v})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
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

const MAX_PER_CALL_RETRIES = 4;

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
      if (attempts >= MAX_PER_CALL_RETRIES) throw err;
    }
  }
};

type ProcessOutcome =
  | "active"
  | "inactive"
  | "trolling"
  | "fetch_failed"
  | "skipped"
  | "out_of_stratum";

type Stats = {
  pagesProcessed: number;
  processed: number;
  active: number;
  inactive: number;
  trolling: number;
  fetchFailed: number;
  skipped: number;
  outOfStratum: number;
};

const newStats = (): Stats => ({
  pagesProcessed: 0,
  processed: 0,
  active: 0,
  inactive: 0,
  trolling: 0,
  fetchFailed: 0,
  skipped: 0,
  outOfStratum: 0,
});

const recordOutcome = (stats: Stats, o: ProcessOutcome): void => {
  stats.processed += 1;
  if (o === "active") stats.active += 1;
  else if (o === "inactive") stats.inactive += 1;
  else if (o === "trolling") stats.trolling += 1;
  else if (o === "fetch_failed") stats.fetchFailed += 1;
  else if (o === "skipped") stats.skipped += 1;
  else if (o === "out_of_stratum") stats.outOfStratum += 1;
};

const processEntry = async (
  entryId: number,
  overallRank: number,
  totalPoints: number,
  stratum: 1 | 2 | 3,
  currentGw: number,
  governor: RateLimitGovernor,
): Promise<ProcessOutcome> => {
  const existing = await prisma.manager_summary.findUnique({
    where: { entry_id: entryId },
    select: { last_checked_gw: true },
  });
  if (existing?.last_checked_gw === currentGw) return "skipped";

  let history;
  try {
    history = await withGovernor(governor, () => fetchEntryHistory(entryId));
  } catch {
    if (governor.shouldAbort) throw new Error("governor_aborted");
    await prisma.manager_summary.upsert({
      where: { entry_id: entryId },
      update: {
        overall_rank: overallRank,
        total_points: totalPoints,
        stratum,
        rejected_reason: "fetch_failed",
        last_checked_gw: currentGw,
      },
      create: {
        entry_id: entryId,
        overall_rank: overallRank,
        total_points: totalPoints,
        stratum,
        rejected_reason: "fetch_failed",
        last_checked_gw: currentGw,
      },
    });
    return "fetch_failed";
  }

  const klass = classifyManager(history, currentGw);
  const rejectedReason = klass === "active" ? null : klass;

  await prisma.manager_summary.upsert({
    where: { entry_id: entryId },
    update: {
      overall_rank: overallRank,
      total_points: totalPoints,
      stratum,
      rejected_reason: rejectedReason,
      last_checked_gw: currentGw,
    },
    create: {
      entry_id: entryId,
      overall_rank: overallRank,
      total_points: totalPoints,
      stratum,
      rejected_reason: rejectedReason,
      last_checked_gw: currentGw,
    },
  });

  // Write per-GW history for every classification. Range-rank queries need
  // inactive/troll managers' real early-GW scores; comparison-average queries
  // can still filter them out via `manager_summary.rejected_reason IS NULL`.
  for (const ev of history.current ?? []) {
    await prisma.manager_history.upsert({
      where: { entry_id_gw: { entry_id: entryId, gw: ev.event } },
      update: {
        points: netPointsForEvent(ev),
        event_transfers: ev.event_transfers,
        event_transfers_cost: ev.event_transfers_cost,
        points_on_bench: ev.points_on_bench,
      },
      create: {
        entry_id: entryId,
        gw: ev.event,
        points: netPointsForEvent(ev),
        event_transfers: ev.event_transfers,
        event_transfers_cost: ev.event_transfers_cost,
        points_on_bench: ev.points_on_bench,
      },
    });
  }

  // Picks ingestion: fill in any (entry_id, gw) we don't already have for
  // finished GWs. This is the steady-state path; bulk backfill lives in
  // `backfillPicks.ts` so a heavy historic re-fetch can run separately
  // without blocking the cron.
  await ingestPicksForMissingGws(entryId, currentGw, governor);

  return klass;
};

// Inline picks ingestion: fetch picks for the LATEST finished GW only,
// and only if not already stored for this manager. Historical depth is
// the job of `backfillPicks.ts` — keeping the cron path bounded to one
// extra FPL call per manager per run means the steady-state load is
// predictable (~5k extra calls / 15-min run) and it stays correct even
// if the backfill never runs.
const ingestPicksForMissingGws = async (
  entryId: number,
  currentGw: number,
  governor: RateLimitGovernor,
): Promise<void> => {
  if (currentGw < 1) return;
  if (governor.shouldAbort) return;

  const existing = await prisma.manager_picks.findUnique({
    where: { entry_id_gw: { entry_id: entryId, gw: currentGw } },
    select: { gw: true },
  });
  if (existing) return;

  let payload;
  try {
    payload = await withGovernor(governor, () =>
      fetchEntryEventPicks(entryId, currentGw),
    );
  } catch {
    // Skip on persistent failure; next cron after the next GW transition
    // (or backfillPicks) will retry.
    return;
  }
  const { captain_element, vice_captain_element, captain_multiplier } =
    summarizePicks(payload.picks ?? []);
  await prisma.manager_picks.upsert({
    where: { entry_id_gw: { entry_id: entryId, gw: currentGw } },
    update: {
      captain_element,
      vice_captain_element,
      captain_multiplier,
      active_chip: payload.active_chip,
    },
    create: {
      entry_id: entryId,
      gw: currentGw,
      captain_element,
      vice_captain_element,
      captain_multiplier,
      active_chip: payload.active_chip,
    },
  });
};

// ---- Stratum A & B: paginated standings ----

const ingestFromStandings = async ({
  cursorKey,
  startPage,
  endPage,
  pageStride,
  stratum,
  budget,
  currentGw,
  governor,
  stats,
}: {
  cursorKey: string;
  startPage: number;
  endPage: number;
  pageStride: number;
  stratum: 1 | 2 | 3;
  budget: number;
  currentGw: number;
  governor: RateLimitGovernor;
  stats: Stats;
}): Promise<void> => {
  let page = await readIntCursor(cursorKey, startPage);
  if (page < startPage) page = startPage;

  while (!governor.shouldAbort && page <= endPage && stats.processed < budget) {
    let pageData;
    try {
      pageData = await withGovernor(governor, () =>
        fetchLeagueStandingsPage(OVERALL_LEAGUE_ID, page),
      );
    } catch {
      if (governor.shouldAbort) break;
      console.warn(
        `[populateManagers] Stratum ${stratum}: skipping page ${page} after repeated failures.`,
      );
      page += pageStride;
      await writeIntCursor(cursorKey, page);
      continue;
    }

    const entries = pageData.standings.results;
    stats.pagesProcessed += 1;

    for (let i = 0; i < entries.length; i += HISTORY_BATCH_SIZE) {
      if (governor.shouldAbort) break;
      if (stats.processed >= budget) break;

      const batch = entries.slice(i, i + HISTORY_BATCH_SIZE);
      const outcomes = await Promise.all(
        batch.map(async (e) => {
          try {
            return await processEntry(
              e.entry,
              e.rank,
              e.total,
              stratum,
              currentGw,
              governor,
            );
          } catch {
            return "fetch_failed" as const;
          }
        }),
      );
      for (const o of outcomes) recordOutcome(stats, o);
      await delay(governor.interBatchDelayMs);
    }

    page += pageStride;
    await writeIntCursor(cursorKey, page);
  }

  if (page > endPage) {
    console.info(
      `[populateManagers] Stratum ${stratum} complete — wrapping cursor to ${startPage}.`,
    );
    await writeIntCursor(cursorKey, startPage);
  }
};

export const populateManagers = async (
  governorConfig?: Partial<GovernorConfig>,
): Promise<void> => {
  if (!acquireLock()) {
    console.info(
      "[populateManagers] Another run holds the lock — exiting cleanly.",
    );
    return;
  }

  const governor = new RateLimitGovernor(
    governorConfig
      ? { ...DEFAULT_GOVERNOR_CONFIG, ...governorConfig }
      : undefined,
  );

  const stats = newStats();

  try {
    const currentGw = await getCurrentFinishedGw();
    if (currentGw < 1) {
      console.warn(
        "[populateManagers] No finished GWs yet — nothing to ingest.",
      );
      return;
    }
    const aPage = await readIntCursor(CURSOR_KEY_A, 1);
    const bPage = await readIntCursor(CURSOR_KEY_B, STRATUM_B_FIRST_PAGE);
    const cPage = await readIntCursor(CURSOR_KEY_C, STRATUM_C_FIRST_PAGE);

    const aDone = aPage > STRATUM_A_LAST_PAGE;
    const bDone = bPage > STRATUM_B_LAST_PAGE;

    // Budget allocation: keep A moving while it has work, but always reserve
    // the bulk of the budget for C so the deep tail fills as quickly as
    // possible. C is now a systematic standings walk (1-in-20), unbiased
    // by construction — sample size is the only remaining lever for
    // accuracy, hence the large allocation.
    let budgetA = 0;
    let budgetB = 0;
    if (!aDone) {
      budgetA = Math.min(BUDGET_A_WHILE_RUNNING, MAX_MANAGERS_PER_RUN);
    }
    const remainingAfterA = MAX_MANAGERS_PER_RUN - budgetA;
    if (!bDone) {
      budgetB = Math.min(BUDGET_B_WHILE_RUNNING, remainingAfterA);
    }
    const budgetC = MAX_MANAGERS_PER_RUN - budgetA - budgetB;

    console.info(
      `[populateManagers] Starting: currentGw ${currentGw}, A page ${aPage}/${STRATUM_A_LAST_PAGE} (budget ${budgetA}), B page ${bPage}/${STRATUM_B_LAST_PAGE} (budget ${budgetB}), C page ${cPage}/${STRATUM_C_LAST_PAGE} stride ${STRATUM_C_PAGE_STRIDE} (budget ${budgetC})`,
    );

    if (budgetA > 0) {
      const target = stats.processed + budgetA;
      await ingestFromStandings({
        cursorKey: CURSOR_KEY_A,
        startPage: 1,
        endPage: STRATUM_A_LAST_PAGE,
        pageStride: 1,
        stratum: 1,
        budget: target,
        currentGw,
        governor,
        stats,
      });
    }

    if (!governor.shouldAbort && budgetB > 0) {
      const target = stats.processed + budgetB;
      await ingestFromStandings({
        cursorKey: CURSOR_KEY_B,
        startPage: STRATUM_B_FIRST_PAGE,
        endPage: STRATUM_B_LAST_PAGE,
        pageStride: STRATUM_B_PAGE_STRIDE,
        stratum: 2,
        budget: target,
        currentGw,
        governor,
        stats,
      });
    }

    if (!governor.shouldAbort && budgetC > 0) {
      const target = stats.processed + budgetC;
      await ingestFromStandings({
        cursorKey: CURSOR_KEY_C,
        startPage: STRATUM_C_FIRST_PAGE,
        endPage: STRATUM_C_LAST_PAGE,
        pageStride: STRATUM_C_PAGE_STRIDE,
        stratum: 3,
        budget: target,
        currentGw,
        governor,
        stats,
      });
    }

    console.info(
      `[populateManagers] Run finished: ${JSON.stringify({ ...stats, aborted: governor.shouldAbort, finalDelayMs: governor.interBatchDelayMs })}`,
    );
  } catch (err) {
    console.error("[populateManagers] Run failed:", (err as Error).message);
  } finally {
    releaseLock();
    await prisma.$disconnect();
  }
};

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  // Slightly looser abort threshold than the governor default. With the
  // standings-walk approach, 404s are no longer routine — every entry
  // returned by `fetchLeagueStandingsPage` is currently ranked, so
  // `fetchEntryHistory` should succeed almost universally. Keeping a
  // wider error budget guards against transient FPL hiccups during
  // multi-hour buildup runs without masking real 429/503 problems
  // (those still trip the dedicated 5-minute pause path).
  await populateManagers({ abortAfterConsecutiveErrors: 20 });
}
