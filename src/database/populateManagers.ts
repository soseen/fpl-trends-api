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
// Stratum C: systematic 1-in-20 walk over the FPL standings tail. Each page
// has 50 entries; stride 20 means we sample 50 of every 1000 ranked
// managers, giving ~12,500 distinct page slots per pass over a 12.6M
// ranked tail (≈ 625k unique probes once full).
//
// We deliberately moved away from random-entry-ID probing here: random IDs
// over-sampled engaged returning users (low IDs 1..3M) and undersampled
// recent joiners (high IDs 10M+), which biased the rank-rank estimate by
// ~12% even with very large samples. The standings page is FPL's own
// ranking, which is exactly the population we want to extrapolate from —
// so a 1-in-N walk is unbiased *in the limit* of a complete cycle.
//
// IMPORTANT: a sequential cursor (page → page+stride → …) gives a heavily
// front-loaded sample mid-cycle: pages 2001..N have all been visited, but
// pages N+1..252000 haven't. Mid-cycle samples therefore over-represent
// the upper end of stratum 3 (current rank 100k–N×50), which has higher
// average GW totals than the deep tail. Observed effect on a fresh prod
// cycle: rank-rank queries over-counted "managers above user" by ~3× in
// stratum 3, blowing the GW-range rank estimate up by 100% on long ranges.
//
// Fix: interleave the slot order using a golden-ratio modular step.
// `STRATUM_C_GOLDEN_STEP` is coprime to `STRATUM_C_NUM_SLOTS`, so the
// sequence `(idx * STEP) mod NUM_SLOTS` for idx = 0,1,2,… is a permutation
// of [0, NUM_SLOTS). After ~10 steps the visited slots are spread evenly
// across the entire rank tail; partial cycles are no longer front-loaded.
//
// LAST_PAGE 252_000 covers ranks up to 12.6M, comfortably above the
// largest observed `events.ranked_count`. Pages past the live tail return
// an empty `standings.results` array, which `ingestFromStandings` handles
// gracefully (page advances, nothing recorded).
const STRATUM_C_FIRST_PAGE = 2001;
const STRATUM_C_LAST_PAGE = 252_000;
const STRATUM_C_PAGE_STRIDE = 20;
const STRATUM_C_NUM_SLOTS = Math.floor(
  (STRATUM_C_LAST_PAGE - STRATUM_C_FIRST_PAGE + 1) / STRATUM_C_PAGE_STRIDE,
); // = 12_500
// Coprime to 12_500 (gcd = 1), ratio ≈ 0.618 (golden). Any prime that is
// neither 2 nor 5 (the prime factors of 12_500) works equally well; 7727
// happens to be the closest prime to 12_500 × (√5 − 1)/2.
const STRATUM_C_GOLDEN_STEP = 7727;
const stratumCPageForIndex = (idx: number): number => {
  const wrapped =
    ((idx % STRATUM_C_NUM_SLOTS) + STRATUM_C_NUM_SLOTS) % STRATUM_C_NUM_SLOTS;
  const slot = (wrapped * STRATUM_C_GOLDEN_STEP) % STRATUM_C_NUM_SLOTS;
  return STRATUM_C_FIRST_PAGE + slot * STRATUM_C_PAGE_STRIDE;
};

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
// Bumped when cursor semantics change in a way that pre-existing cursor
// values would be silently misinterpreted. v1 = raw page number (pre
// golden-step refactor). v2 = iteration index within a walk's `numSteps`.
const CURSOR_FORMAT_KEY = "manager_walk_cursor_version";
const CURRENT_CURSOR_FORMAT_VERSION = 2;
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

  // Rebuild manager_cumulative for this entry. range-rank's hot query
  // (stratumCounts) reads cumulative_points instead of GROUP-BY-ing
  // manager_history every call — see getRangeRank.ts.
  await rebuildCumulativeForEntry(entryId, stratum, rejectedReason);

  // Picks ingestion: fill in any (entry_id, gw) we don't already have for
  // finished GWs. This is the steady-state path; bulk backfill lives in
  // `backfillPicks.ts` so a heavy historic re-fetch can run separately
  // without blocking the cron.
  await ingestPicksForMissingGws(entryId, currentGw, governor);

  return klass;
};

// Per-entry cumulative rebuild: DELETE all this entry's manager_cumulative
// rows then INSERT one fresh row per (entry_id, gw) where manager_history
// has a row. Keeping cumulative as a strict mirror of history (no synthetic
// anchor rows, no rows for non-participated GWs) is what lets the range
// query use DISTINCT ON to find the latest in-range row per entry — see
// getRangeRank.ts.
//
// Re-querying manager_history rather than computing from `history.current`
// is intentional: if FPL ever returns a smaller payload than what we've
// already persisted (we never delete history rows), the DB query is
// canonical. Stratum and rejected_reason are denormalised onto every row
// so the read path needs no manager_summary join.
const rebuildCumulativeForEntry = async (
  entryId: number,
  stratum: 1 | 2 | 3,
  rejectedReason: string | null,
): Promise<void> => {
  const histRows = await prisma.manager_history.findMany({
    where: { entry_id: entryId },
    orderBy: { gw: "asc" },
    select: { gw: true, points: true },
  });

  let acc = 0;
  const cumRows = histRows.map((r) => {
    acc += r.points;
    return { gw: r.gw, cum: acc };
  });

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`DELETE FROM manager_cumulative WHERE entry_id = ${entryId}`;
    if (cumRows.length === 0) return;

    const tuples: string[] = [];
    const values: unknown[] = [];
    for (let i = 0; i < cumRows.length; i++) {
      const base = i * 5;
      const r = cumRows[i]!;
      tuples.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`,
      );
      values.push(entryId, r.gw, r.cum, stratum, rejectedReason);
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO manager_cumulative
         (entry_id, gw, cumulative_points, stratum, rejected_reason)
       VALUES ${tuples.join(", ")}`,
      ...values,
    );
  });
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

// ---- Stratum A / B / C: paginated standings ----
//
// Each stratum has a "walk plan": how many distinct pages exist in one
// cycle, and how to map an iteration index → standings page number.
//
// S1 and S2 are full-census strides (every page visited once), so the
// mapping is trivial (idx → first_page + idx). S3 is a 1-in-N stride
// over a much larger range; to keep partial cycles unbiased we visit
// slots in golden-ratio interleaved order (see `stratumCPageForIndex`).
//
// The cursor stored in `app_metadata` is the *iteration index* (0-based
// step count within the current cycle), not the raw page number. When a
// cycle completes, the cursor wraps back to 0.
type StratumWalk = {
  cursorKey: string;
  numSteps: number;
  pageOf: (idx: number) => number;
  stratum: 1 | 2 | 3;
};

const STRATUM_A_WALK: StratumWalk = {
  cursorKey: CURSOR_KEY_A,
  numSteps: STRATUM_A_LAST_PAGE,
  pageOf: (idx) => idx + 1,
  stratum: 1,
};

const STRATUM_B_WALK: StratumWalk = {
  cursorKey: CURSOR_KEY_B,
  numSteps: STRATUM_B_LAST_PAGE - STRATUM_B_FIRST_PAGE + 1,
  pageOf: (idx) => STRATUM_B_FIRST_PAGE + idx,
  stratum: 2,
};

const STRATUM_C_WALK: StratumWalk = {
  cursorKey: CURSOR_KEY_C,
  numSteps: STRATUM_C_NUM_SLOTS,
  pageOf: stratumCPageForIndex,
  stratum: 3,
};

const ingestFromStandings = async ({
  walk,
  budget,
  currentGw,
  governor,
  stats,
}: {
  walk: StratumWalk;
  budget: number;
  currentGw: number;
  governor: RateLimitGovernor;
  stats: Stats;
}): Promise<void> => {
  // Read the iteration index. Pre-refactor the cursor stored a raw page
  // number; if we still see one of those (e.g. > numSteps), fall back to
  // 0 so a partial-cycle deploy doesn't get stuck in an out-of-range
  // state.
  let idx = await readIntCursor(walk.cursorKey, 0);
  if (idx < 0 || idx >= walk.numSteps) idx = 0;

  while (
    !governor.shouldAbort &&
    idx < walk.numSteps &&
    stats.processed < budget
  ) {
    const page = walk.pageOf(idx);

    let pageData;
    try {
      pageData = await withGovernor(governor, () =>
        fetchLeagueStandingsPage(OVERALL_LEAGUE_ID, page),
      );
    } catch {
      if (governor.shouldAbort) break;
      console.warn(
        `[populateManagers] Stratum ${walk.stratum}: skipping page ${page} after repeated failures.`,
      );
      idx += 1;
      await writeIntCursor(walk.cursorKey, idx);
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
              walk.stratum,
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

    idx += 1;
    await writeIntCursor(walk.cursorKey, idx);
  }

  if (idx >= walk.numSteps) {
    console.info(
      `[populateManagers] Stratum ${walk.stratum} complete — wrapping cursor to 0.`,
    );
    await writeIntCursor(walk.cursorKey, 0);
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

    // One-time migration: pre-refactor cursors stored raw page numbers,
    // which would be silently misread as iteration indices by the new
    // walk logic (e.g. cursor=5000 in v1 meant "page 5000", in v2 means
    // "step 5000 within the walk"). Reset all three cursors on first
    // run after the format bump so the new walks start fresh.
    const cursorVersion = await readIntCursor(CURSOR_FORMAT_KEY, 0);
    if (cursorVersion < CURRENT_CURSOR_FORMAT_VERSION) {
      console.info(
        `[populateManagers] Cursor format ${cursorVersion} → ${CURRENT_CURSOR_FORMAT_VERSION}: resetting walk cursors.`,
      );
      await writeIntCursor(CURSOR_KEY_A, 0);
      await writeIntCursor(CURSOR_KEY_B, 0);
      await writeIntCursor(CURSOR_KEY_C, 0);
      await writeIntCursor(CURSOR_FORMAT_KEY, CURRENT_CURSOR_FORMAT_VERSION);
    }

    // Cursors are now iteration indices (0-based) within their walk's
    // `numSteps`. Old deploys stored raw page numbers; values out of
    // [0, numSteps) get treated as "fresh start" by ingestFromStandings.
    const aIdx = await readIntCursor(CURSOR_KEY_A, 0);
    const bIdx = await readIntCursor(CURSOR_KEY_B, 0);
    const cIdx = await readIntCursor(CURSOR_KEY_C, 0);

    // Treat A/B as "done for this pass" only when the cursor sits at the
    // end of the iteration range. C never goes "done" on the same
    // condition because we want to keep refilling its sample (cycle wraps
    // each time A and B finish a pass).
    const aDone = aIdx >= STRATUM_A_WALK.numSteps;
    const bDone = bIdx >= STRATUM_B_WALK.numSteps;

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
      `[populateManagers] Starting: currentGw ${currentGw}, A idx ${aIdx}/${STRATUM_A_WALK.numSteps} (budget ${budgetA}), B idx ${bIdx}/${STRATUM_B_WALK.numSteps} (budget ${budgetB}), C idx ${cIdx}/${STRATUM_C_WALK.numSteps} (interleaved, budget ${budgetC})`,
    );

    if (budgetA > 0) {
      const target = stats.processed + budgetA;
      await ingestFromStandings({
        walk: STRATUM_A_WALK,
        budget: target,
        currentGw,
        governor,
        stats,
      });
    }

    if (!governor.shouldAbort && budgetB > 0) {
      const target = stats.processed + budgetB;
      await ingestFromStandings({
        walk: STRATUM_B_WALK,
        budget: target,
        currentGw,
        governor,
        stats,
      });
    }

    if (!governor.shouldAbort && budgetC > 0) {
      const target = stats.processed + budgetC;
      await ingestFromStandings({
        walk: STRATUM_C_WALK,
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
