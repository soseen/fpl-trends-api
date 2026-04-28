import "dotenv/config";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "node:url";
import { prisma } from "./client.js";
import {
  fetchEntryHistory,
  fetchEntrySummary,
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

// ---- Stratum boundaries (must match getRangeRank.ts) ----
// Stratum 3 upper bound is dynamic — derived from `events.ranked_count`
// at runtime so it tracks FPL's growing tail. Fallback used only when no
// finished GWs exist.
const STRATUM_A_MAX = 10_000;
const STRATUM_B_MAX = 100_000;
const STRATUM_C_MAX_FALLBACK = 15_000_000;

// Stratum A: full census of the top 10k. 200 pages × 50 entries.
const STRATUM_A_LAST_PAGE = 200;
// Stratum B: pages 201–2000, take every Nth page = 1-in-5 sampling.
const STRATUM_B_FIRST_PAGE = 201;
const STRATUM_B_LAST_PAGE = 2000;
const STRATUM_B_PAGE_STRIDE = 5;
// Stratum C: random ID probing in this range. Bumped past 13M so probes
// can find managers in the deep tail FPL has grown into (>12.6M ranked
// as of late season).
const STRATUM_C_ID_MIN = 1;
const STRATUM_C_ID_MAX = 15_000_000;

// Per-run safety cap. Cron fires every 15 min; at ~25 req/s sustained this
// is ~10 min of work per run, leaving slack for governor backoffs and
// preventing overlap with the next cron.
const MAX_MANAGERS_PER_RUN = 15000;

// Budget split when stratum A is still in progress vs done. A and B refresh
// existing rows (their populations are bounded — 10k and 18k respectively),
// so they only need a steady trickle. Most of the per-run budget goes to
// stratum C, where each new probe is a previously-unseen manager and the
// extrapolation factor is ~250× even at the bumped sample target.
const BUDGET_A_WHILE_RUNNING = 2000;
const BUDGET_B_WHILE_RUNNING = 2000;

// Concurrency within each batch. Combined with the governor's inter-batch
// delay (default 300 ms) this gives ~25 req/s sustained.
const HISTORY_BATCH_SIZE = 8;

const CURSOR_KEY_A = "manager_ingest_cursor_a";
const CURSOR_KEY_B = "manager_ingest_cursor_b";
const LOCKFILE_PATH = path.join(os.tmpdir(), "fpl-populate-managers.lock");

const acquireLock = (): boolean => {
  try {
    fs.writeFileSync(LOCKFILE_PATH, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
};

const releaseLock = (): void => {
  try {
    fs.unlinkSync(LOCKFILE_PATH);
  } catch {
    /* ignore */
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

const stratumByRank = (rank: number, cMax: number): 1 | 2 | 3 | null => {
  if (rank <= STRATUM_A_MAX) return 1;
  if (rank <= STRATUM_B_MAX) return 2;
  if (rank <= cMax) return 3;
  return null;
};

const fetchStratumCMax = async (): Promise<number> => {
  const row = await prisma.events.aggregate({
    where: { finished: true },
    _max: { ranked_count: true },
  });
  return row._max.ranked_count ?? STRATUM_C_MAX_FALLBACK;
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

// ---- Stratum C: random ID probing ----

const randomEntryId = (): number =>
  STRATUM_C_ID_MIN +
  Math.floor(Math.random() * (STRATUM_C_ID_MAX - STRATUM_C_ID_MIN + 1));

const ingestStratumC = async ({
  budget,
  currentGw,
  cMax,
  governor,
  stats,
}: {
  budget: number;
  currentGw: number;
  cMax: number;
  governor: RateLimitGovernor;
  stats: Stats;
}): Promise<void> => {
  while (!governor.shouldAbort && stats.processed < budget) {
    const probesThisBatch = Math.min(
      HISTORY_BATCH_SIZE,
      budget - stats.processed,
    );
    const ids = Array.from({ length: probesThisBatch }, () => randomEntryId());

    const outcomes = await Promise.all(
      ids.map(async (id) => {
        let summary;
        try {
          summary = await withGovernor(governor, () => fetchEntrySummary(id));
        } catch {
          return "fetch_failed" as const;
        }

        const rank = summary.summary_overall_rank;
        if (rank === null || stratumByRank(rank, cMax) !== 3) {
          return "out_of_stratum" as const;
        }

        try {
          return await processEntry(
            id,
            rank,
            summary.summary_overall_points ?? 0,
            3,
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
    const cMax = await fetchStratumCMax();

    const aPage = await readIntCursor(CURSOR_KEY_A, 1);
    const bPage = await readIntCursor(CURSOR_KEY_B, STRATUM_B_FIRST_PAGE);

    const aDone = aPage > STRATUM_A_LAST_PAGE;
    const bDone = bPage > STRATUM_B_LAST_PAGE;

    // Budget allocation: keep A moving while it has work, but always reserve
    // some budget for C so the deep tail starts to fill from day one.
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
      `[populateManagers] Starting: currentGw ${currentGw}, A page ${aPage}/${STRATUM_A_LAST_PAGE} (budget ${budgetA}), B page ${bPage}/${STRATUM_B_LAST_PAGE} (budget ${budgetB}), C random (budget ${budgetC})`,
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
      await ingestStratumC({
        budget: target,
        currentGw,
        cMax,
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
  await populateManagers();
}
