import { samplePages } from "../analytics/sampling.js";
import axios from "axios";
import { enqueue, seasonState } from "../analytics/store.js";
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
import { netPointsForEvent } from "../managers/activityFilter.js";
import {
  fetchEntryEventPicks,
  summarizePicks,
} from "../managers/fetchPicks.js";
import { persistPickElements } from "../managers/persistPickElements.js";
import { refreshOverallRankCurveSnapshot } from "../managers/rankCurveSnapshot.js";
import { fetchEntryTransfers } from "../managers/fetchTransfers.js";
import {
  RateLimitGovernor,
  DEFAULT_GOVERNOR_CONFIG,
  type GovernorConfig,
} from "../managers/rateLimitGovernor.js";
import { delay } from "../utils.js";
import {
  evaluateObservedSeasonClosure,
  markSeasonClosureJobComplete,
} from "./seasonManager.js";

// Stratum A: full census of the top 10k. 200 pages × 50 entries.
const readEnvInt = (key: string, fallback: number, min = 1): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  return parsed;
};

const readEnvBool = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
};

const STRATUM_C_TARGET_MANAGERS = 20_000;

// Per-run safety cap. Cron fires every 15 min; at ~25 req/s sustained this
// is ~13 min of work per run, leaving slack for governor backoffs and
// preventing overlap with the next cron.
const MAX_MANAGERS_PER_RUN = readEnvInt("MANAGER_MAX_PER_RUN", 20_000, 1_000);

// Split each run across the bounded 10k / 10k / 20k source samples. Tail
// sampling gets the remaining budget because its extrapolation is largest.
const BUDGET_A_WHILE_RUNNING = readEnvInt("MANAGER_BUDGET_A", 5_000, 0);
const BUDGET_B_WHILE_RUNNING = readEnvInt("MANAGER_BUDGET_B", 5_000, 0);

// Sample-side enrichment used by My Trends captaincy, EO, and transfer-value
// comparisons. The env flags remain as kill switches if FPL rate limiting gets
// tight, but steady-state cron should keep future GWs complete by default.
const INGEST_SAMPLE_PICKS = readEnvBool("MANAGER_INGEST_SAMPLE_PICKS", true);
const INGEST_SAMPLE_TRANSFERS = readEnvBool(
  "MANAGER_INGEST_SAMPLE_TRANSFERS",
  true,
);

// Concurrency within each batch. Combined with the governor's inter-batch
// delay (default 300 ms) this gives ~25 req/s sustained.
const HISTORY_BATCH_SIZE = 8;

const CURSOR_KEY_A = "manager_ingest_cursor_a";
const CURSOR_KEY_B = "manager_ingest_cursor_b";
const CURSOR_KEY_C = "manager_ingest_cursor_c";
const SAMPLE_GW_KEY = "manager_sample_gw";
const SAMPLE_GW_FINALIZED_KEY = "manager_sample_gw_finalized";
const SAMPLE_GW_CLEANED_KEY = "manager_sample_gw_cleaned";
// Bumped when cursor semantics change in a way that pre-existing cursor
// values would be silently misinterpreted or when steady-state enrichment
// needs a one-time same-GW repair pass. v1 = raw page number (pre
// golden-step refactor). v2 = iteration index within a walk's `numSteps`.
// v3 = bounded per-GW sample: completed walks stay complete until GW changes.
// v4 = same-GW repair for chips/current picks after the prod GW35 pass ran
// with sample-pick ingestion disabled.
const CURSOR_FORMAT_KEY = "manager_walk_cursor_version";
const CURRENT_CURSOR_FORMAT_VERSION = 5;
const LOCKFILE_PATH = path.join(os.tmpdir(), "fpl-populate-managers.lock");
// Conservative max age — a normal run is ~13 min, peak ~20 min on heavy
// ticks. Anything past 30 min is stuck: a DB query that's spinning on
// disk pressure, an FPL HTTP call without a timeout, or a hard hang we
// can't otherwise see. We treat it as recoverable and reclaim — see
// isLockStale below.
const LOCK_MAX_AGE_MS = 30 * 60 * 1000;

const releaseLock = (): void => {
  try {
    if (fs.readFileSync(LOCKFILE_PATH, "utf8").trim() !== String(process.pid))
      return;
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

  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(LOCKFILE_PATH).mtimeMs;
  } catch {
    return false;
  }
  const tooOld = Date.now() - mtimeMs > LOCK_MAX_AGE_MS;

  const pid = parseInt(contents.trim(), 10);
  if (Number.isFinite(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      // ESRCH = process is gone (stale, regardless of age).
      // EPERM = exists but owned by another user — leave it alone.
      return (err as NodeJS.ErrnoException).code === "ESRCH";
    }
    // Process is alive. Fresh = let it run; stuck-past-LOCK_MAX_AGE = kill
    // it and reclaim. Without this, a hung populate-managers (e.g. blocked
    // on a Postgres query during a disk-pressure incident) holds the lock
    // forever and every subsequent cron tick exits with "Another run
    // holds the lock".
    if (!tooOld) return false;
    try {
      process.kill(pid, "SIGTERM");
      console.warn(
        `[populateManagers] Lockfile age exceeds ${LOCK_MAX_AGE_MS / 60_000} min — SIGTERM'd alive-but-stuck PID ${pid}.`,
      );
    } catch {
      // Race: process exited between our liveness check and the signal.
      // Either way, fall through to the stale path.
    }
    return true;
  }

  // PID unparseable — fall back to mtime so a corrupt lockfile can still
  // self-heal once it's well past any plausible run length.
  return tooOld;
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

const clearCurrentGwSampleRows = async (gw: number): Promise<void> => {
  // Preserve facts and the last immutable publication while recollecting.
  // Only provenance is reset; the new sample explicitly opts back in.
  await prisma.$executeRaw`UPDATE manager_picks SET sampled_at_gw=NULL,sample_stratum=NULL WHERE gw=${gw}`;
};

type SampleGameweek = {
  gw: number;
  isLive: boolean;
};

const getCurrentSampleGameweek = async (): Promise<SampleGameweek> => {
  const rows = await prisma.events.findMany({
    where: {
      OR: [{ is_current: true }, { finished: true }],
    },
    select: { id: true, finished: true, is_current: true },
    orderBy: { id: "desc" },
    take: 1,
  });
  const event = rows[0];
  return {
    gw: event?.id ?? 0,
    isLive: Boolean(event?.is_current && !event.finished),
  };
};

export const shouldResetCurrentGwSample = ({
  sampleGw,
  currentGw,
  isLiveCurrentGw,
  sampleGwFinalized,
  sampleGwCleaned,
}: {
  sampleGw: number;
  currentGw: number;
  isLiveCurrentGw: boolean;
  sampleGwFinalized: number;
  sampleGwCleaned: number;
}): boolean =>
  sampleGw !== currentGw ||
  (!isLiveCurrentGw &&
    (sampleGwFinalized === 0 ||
      (sampleGwFinalized === 2 && sampleGwCleaned !== currentGw)));

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
  | "ingested"
  | "fetch_failed"
  | "skipped"
  | "out_of_stratum";

type Stats = {
  pagesProcessed: number;
  processed: number;
  ingested: number;
  fetchFailed: number;
  skipped: number;
  outOfStratum: number;
};

const newStats = (): Stats => ({
  pagesProcessed: 0,
  processed: 0,
  ingested: 0,
  fetchFailed: 0,
  skipped: 0,
  outOfStratum: 0,
});

const recordOutcome = (stats: Stats, o: ProcessOutcome): void => {
  stats.processed += 1;
  if (o === "ingested") stats.ingested += 1;
  else if (o === "fetch_failed") stats.fetchFailed += 1;
  else if (o === "skipped") stats.skipped += 1;
  else if (o === "out_of_stratum") stats.outOfStratum += 1;
};

const hasCompletePicksForGw = async (
  entryId: number,
  gw: number,
): Promise<boolean> => {
  if (gw < 1) return true;

  const [existing, elementRows] = await Promise.all([
    prisma.manager_picks.findUnique({
      where: { entry_id_gw: { entry_id: entryId, gw } },
      select: { gw: true },
    }),
    prisma.manager_pick_elements.count({
      where: { entry_id: entryId, gw },
    }),
  ]);

  return Boolean(existing && elementRows >= 15);
};

const processEntry = async (
  entryId: number,
  overallRank: number,
  totalPoints: number,
  stratum: 1 | 2 | 3,
  currentGw: number,
  isLiveCurrentGw: boolean,
  forceRefreshCurrentGw: boolean,
  governor: RateLimitGovernor,
  sourcePage: number,
): Promise<ProcessOutcome> => {
  const existing = await prisma.manager_summary.findUnique({
    where: { entry_id: entryId },
    select: {
      last_checked_gw: true,
      has_chip_history: true,
      has_transfer_history: true,
      history: {
        where: { overall_rank: null },
        select: { gw: true },
        take: 1,
      },
    },
  });

  const alreadyCheckedCurrentGw = existing?.last_checked_gw === currentGw;
  const currentGwPicksComplete =
    !INGEST_SAMPLE_PICKS ||
    !alreadyCheckedCurrentGw ||
    (await hasCompletePicksForGw(entryId, currentGw));
  const needsTransferHistory =
    INGEST_SAMPLE_TRANSFERS && !existing?.has_transfer_history;
  if (
    !forceRefreshCurrentGw &&
    !isLiveCurrentGw &&
    alreadyCheckedCurrentGw &&
    existing.has_chip_history &&
    existing.history.length === 0 &&
    currentGwPicksComplete &&
    !needsTransferHistory
  ) {
    await prisma.manager_picks.updateMany({
      where: { entry_id: entryId, gw: currentGw },
      data: {
        sample_stratum: stratum,
        sampled_at_gw: currentGw,
        sample_page: sourcePage,
      },
    });
    return "skipped";
  }

  let history;
  try {
    history = await withGovernor(governor, () => fetchEntryHistory(entryId));
  } catch (error) {
    if (governor.shouldAbort) throw new Error("governor_aborted");
    if (axios.isAxiosError(error) && error.response?.status === 404)
      return "skipped";
    return "fetch_failed";
  }

  if (history.current.some((ev) => ev.event > currentGw)) {
    throw new Error(
      "Manager history is ahead of local event data; refresh bulk data before collecting the sample",
    );
  }

  await prisma.manager_summary.upsert({
    where: { entry_id: entryId },
    update: {
      overall_rank: overallRank,
      total_points: totalPoints,
      stratum,
      last_checked_gw: currentGw,
      has_chip_history: true,
    },
    create: {
      entry_id: entryId,
      overall_rank: overallRank,
      total_points: totalPoints,
      stratum,
      last_checked_gw: currentGw,
      has_chip_history: true,
    },
  });

  const chipByGw = new Map(
    (history.chips ?? []).map((chip) => [chip.event, chip.name]),
  );
  const currentEvent = (history.current ?? []).find(
    (ev) => ev.event === currentGw,
  );
  const currentChip = chipByGw.get(currentGw) ?? null;

  // Write per-GW history for every manager — no activity classification.
  // Inactive / trolling / "abnormal" managers are valid sample data; the
  // old rejected_reason filter excluded them from rank-density math, but
  // we now treat the full sample as-is (lighter ingest, simpler reads).
  const facts = (history.current ?? []).map((ev) => ({
    gw: ev.event,
    points: netPointsForEvent(ev),
    rank: ev.overall_rank,
    transfers: ev.event_transfers,
    hits: ev.event_transfers_cost,
    bench: ev.points_on_bench,
    chip: chipByGw.get(ev.event) ?? null,
  }));
  await prisma.$executeRaw`INSERT INTO manager_history(entry_id,gw,points,overall_rank,event_transfers,event_transfers_cost,points_on_bench,active_chip)
    SELECT ${entryId},f.gw,f.points,f.rank,f.transfers,f.hits,f.bench,f.chip FROM jsonb_to_recordset(${JSON.stringify(facts)}::jsonb) AS f(gw int,points int,rank int,transfers int,hits int,bench int,chip text)
    ON CONFLICT(entry_id,gw) DO UPDATE SET points=excluded.points,overall_rank=excluded.overall_rank,event_transfers=excluded.event_transfers,event_transfers_cost=excluded.event_transfers_cost,points_on_bench=excluded.points_on_bench,active_chip=excluded.active_chip
    WHERE (manager_history.points,manager_history.overall_rank,manager_history.event_transfers,manager_history.event_transfers_cost,manager_history.points_on_bench,manager_history.active_chip) IS DISTINCT FROM (excluded.points,excluded.overall_rank,excluded.event_transfers,excluded.event_transfers_cost,excluded.points_on_bench,excluded.active_chip)`;

  // Fill in the latest sampled GW for captaincy and EO. During live GWs this
  // is the current GW, so My Trends can converge while matches are still
  // being played.
  if (INGEST_SAMPLE_PICKS) {
    await ingestPicksForMissingGws(
      entryId,
      currentGw,
      stratum,
      governor,
      isLiveCurrentGw || forceRefreshCurrentGw,
      sourcePage,
    );
  }

  if (isLiveCurrentGw) {
    // Standings already include live scores while entry/history can contain
    // a zero-point placeholder. Keep the same score/rank pair as the walk.
    await prisma.$executeRaw`
      UPDATE manager_history
      SET points = ${totalPoints} - COALESCE((
        SELECT SUM(previous.points) FROM manager_history previous
        WHERE previous.entry_id = ${entryId} AND previous.gw < ${currentGw}
      ), 0), overall_rank = ${overallRank}
      WHERE entry_id = ${entryId} AND gw = ${currentGw}
    `;
  }

  // Rebuild manager_cumulative for this entry after optional picks are current
  // so captain-derived running fields are reflected immediately. Chip fields
  // come from manager_history.active_chip, stored from the history payload.
  // Range benchmarks now read bounded facts; cumulative season rewrites are retired.

  // Keep sample transfer logs current without refetching every unchanged
  // manager on every GW pass. Fetch once for coverage, then again only when
  // the newly finished GW could have appended transfer rows.
  const shouldIngestTransfers =
    INGEST_SAMPLE_TRANSFERS &&
    (!existing?.has_transfer_history ||
      (currentEvent?.event_transfers ?? 0) > 0 ||
      currentChip === "wildcard" ||
      currentChip === "freehit");
  if (shouldIngestTransfers) {
    await ingestTransfersForEntry(entryId, governor);
  }

  return "ingested";
};

// Boundary GW between FPL chip halves. Each chip can be played at most once
// in [1..CHIP_HALVES_BOUNDARY] and once in (CHIP_HALVES_BOUNDARY..38]. The
// h1/h2 cumulative flags rely on this split so any (start, end) range can
// detect a chip play via XOR of c_end and c_start halves.
// Inline picks ingestion: fetch picks for the latest sampled GW only,
// and only if not already stored for this manager. Historical depth is
// the job of `backfillPicks.ts` — keeping the cron path bounded to one
// extra FPL call per manager per run means the steady-state load is
// predictable (~5k extra calls / 15-min run) and it stays correct even
// if the backfill never runs.
const ingestPicksForMissingGws = async (
  entryId: number,
  currentGw: number,
  sampleStratum: 1 | 2 | 3,
  governor: RateLimitGovernor,
  refresh = false,
  sourcePage?: number,
): Promise<void> => {
  if (currentGw < 1) return;
  if (governor.shouldAbort) return;

  const [existing, elementRows] = await Promise.all([
    prisma.manager_picks.findUnique({
      where: { entry_id_gw: { entry_id: entryId, gw: currentGw } },
      select: { gw: true },
    }),
    prisma.manager_pick_elements.count({
      where: { entry_id: entryId, gw: currentGw },
    }),
  ]);
  if (existing && elementRows >= 15 && !refresh) {
    await prisma.manager_picks.update({
      where: { entry_id_gw: { entry_id: entryId, gw: currentGw } },
      data: {
        sample_stratum: sampleStratum,
        sampled_at_gw: currentGw,
        sample_page: sourcePage ?? null,
      },
    });
    return;
  }

  let payload;
  try {
    payload = await withGovernor(governor, () =>
      fetchEntryEventPicks(entryId, currentGw),
    );
  } catch (error) {
    throw new Error(`Sample picks fetch failed for GW${currentGw}`, {
      cause: error,
    });
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
      sample_stratum: sampleStratum,
      sampled_at_gw: currentGw,
      sample_page: sourcePage ?? null,
    },
    create: {
      entry_id: entryId,
      gw: currentGw,
      captain_element,
      vice_captain_element,
      captain_multiplier,
      active_chip: payload.active_chip,
      sample_stratum: sampleStratum,
      sampled_at_gw: currentGw,
      sample_page: sourcePage ?? null,
    },
  });
  await persistPickElements(entryId, currentGw, payload.picks ?? []);
};

// One FPL fetch for managers missing transfer coverage, then again only when
// the latest sampled GW could have appended rows. The transfer log is
// append-only on FPL's side, so managers with no new transfer/chip activity can
// keep using their persisted rows.
//
// A failure leaves `has_transfer_history = false` so the next pass retries.
const ingestTransfersForEntry = async (
  entryId: number,
  governor: RateLimitGovernor,
): Promise<void> => {
  if (governor.shouldAbort) return;

  let transfers;
  try {
    transfers = await withGovernor(governor, () =>
      fetchEntryTransfers(entryId),
    );
  } catch (error) {
    await prisma.manager_summary.update({
      where: { entry_id: entryId },
      data: { has_transfer_history: false },
    });
    throw new Error("Sample transfer history fetch failed", { cause: error });
  }

  // Single multi-row insert with ON CONFLICT … DO NOTHING — append-only
  // semantics, matches the unique-by-construction (entry_id, gw, in, out)
  const sourceSeason = await prisma.app_metadata.findUnique({
    where: { key: "current_season" },
  });
  if (sourceSeason)
    await prisma.$executeRaw`INSERT INTO analytics_manager_sources(season,entry_id,kind,payload) VALUES (${sourceSeason.value},${entryId},'transfers',${JSON.stringify(transfers)}::jsonb) ON CONFLICT(season,entry_id,kind) DO UPDATE SET payload=excluded.payload,fetched_at=now()`;

  // PK from manager_transfers.
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

  // Mark even when transfers.length === 0 — a manager who has never made
  // a transfer is fully ingested by virtue of confirming the empty list.
  // Raw SQL: bypasses the typed Prisma client (which can be stale on
  // Windows dev when prisma generate's query_engine.dll rename is blocked
  // by an active tsx process); the SELECT path against the same column
  // already uses raw SQL throughout this codebase.
  await prisma.$executeRawUnsafe(
    `UPDATE manager_summary SET has_transfer_history = true WHERE entry_id = $1`,
    entryId,
  );
};

// ---- Stratum A / B / C: paginated standings ----
//
// Each stratum has a "walk plan": how many distinct pages exist in one
// cycle, and how to map an iteration index → standings page number.
//
// Each GW has a deterministic page permutation. A visits the top-10k frame;
// B and C select bounded page clusters without replacement from their frames.
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

const ingestFromStandings = async ({
  walk,
  budget,
  currentGw,
  isLiveCurrentGw,
  forceRefreshCurrentGw,
  governor,
  stats,
}: {
  walk: StratumWalk;
  budget: number;
  currentGw: number;
  isLiveCurrentGw: boolean;
  forceRefreshCurrentGw: boolean;
  governor: RateLimitGovernor;
  stats: Stats;
}): Promise<void> => {
  // Read the iteration index. Pre-refactor the cursor stored a raw page
  // number; if we still see one of those (e.g. > numSteps), fall back to
  // 0 so a partial-cycle deploy doesn't get stuck in an out-of-range
  // state.
  let idx = await readIntCursor(walk.cursorKey, 0);
  if (idx < 0) idx = 0;
  if (idx >= walk.numSteps) {
    if (!isLiveCurrentGw) return;
    idx = 0;
    await writeIntCursor(walk.cursorKey, idx);
  }

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
    } catch (error) {
      // Leave the cursor on this page; a transient outage must not silently
      // remove a cluster from the sample or mark an incomplete walk finalized.
      throw new Error(
        `Standings page ${page} in stratum ${walk.stratum} failed`,
        { cause: error },
      );
    }

    const entries = pageData.standings.results;
    stats.pagesProcessed += 1;

    let pageComplete = true,
      completedEntries = 0;
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
              isLiveCurrentGw,
              forceRefreshCurrentGw,
              governor,
              page,
            );
          } catch (error) {
            console.error(
              JSON.stringify({
                event: "sample_entry_failed",
                entry: e.entry,
                gw: currentGw,
                stratum: walk.stratum,
                cause: error instanceof Error ? error.message : String(error),
              }),
            );
            return "fetch_failed" as const;
          }
        }),
      );
      for (const o of outcomes) recordOutcome(stats, o);
      completedEntries += outcomes.length;
      if (outcomes.some((o) => o === "fetch_failed")) pageComplete = false;
      await delay(governor.interBatchDelayMs);
    }

    if (
      !pageComplete ||
      governor.shouldAbort ||
      completedEntries !== entries.length
    )
      throw new Error(
        `Sample page ${page} was not completely ingested; its cursor is retained for retry`,
      );
    idx += 1;
    await writeIntCursor(walk.cursorKey, idx);
  }

  if (idx >= walk.numSteps) {
    console.info(
      `[populateManagers] Stratum ${walk.stratum} complete for this GW.`,
    );
    await writeIntCursor(walk.cursorKey, isLiveCurrentGw ? 0 : walk.numSteps);
  }
};

type ManagerReadModelRebuildOptions = {
  rangeBuckets?: "all" | "latest";
  exposureGw?: number;
};

export const rebuildManagerReadModels = async ({
  rangeBuckets = "all",
  exposureGw,
}: ManagerReadModelRebuildOptions = {}): Promise<void> => {
  const { season } = await seasonState({ allowBulkRefresh: true });
  const latest = await prisma.events.aggregate({ _max: { id: true } });
  const end = exposureGw ?? latest._max.id ?? 0;
  for (let gw = rangeBuckets === "all" ? 1 : end; gw <= end; gw++)
    await enqueue({
      key: `benchmark:${season}:${gw}`,
      kind: "benchmark",
      season,
      start: gw,
      end: gw,
    });
  console.info(
    JSON.stringify({
      event: "benchmark_jobs_enqueued",
      season,
      end,
      mode: rangeBuckets,
    }),
  );
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
    const seasonClosureDecision =
      await evaluateObservedSeasonClosure("manager-ingest");
    if (!seasonClosureDecision.shouldRun) {
      console.info(
        `[populateManagers] Season ingest skipped: ${seasonClosureDecision.reason}.`,
      );
      return;
    }
    console.info(
      `[populateManagers] Season ingest allowed: ${seasonClosureDecision.reason}.`,
    );

    const { gw: currentGw, isLive: isLiveCurrentGw } =
      await getCurrentSampleGameweek();
    if (currentGw < 1) {
      console.warn(
        "[populateManagers] No active or finished GWs yet - nothing to ingest.",
      );
      return;
    }

    const { season } = await seasonState();
    const populationKey = `analytics_sample_population:${season}:${currentGw}`;
    const storedPopulation = await prisma.app_metadata.findUnique({
      where: { key: populationKey },
    });
    const population = storedPopulation
      ? Number(storedPopulation.value)
      : ((
          await prisma.events.findUnique({
            where: { id: currentGw },
            select: { ranked_count: true },
          })
        )?.ranked_count ?? 0);
    if (population <= 0)
      throw new Error("Cannot sample an unknown ranked population");
    if (!storedPopulation)
      await prisma.app_metadata.create({
        data: { key: populationKey, value: String(population) },
      });
    const plans = [
      samplePages(
        1,
        Math.min(200, Math.ceil(population / 50)),
        200,
        `${season}:${currentGw}:1`,
      ),
      samplePages(
        201,
        Math.min(2000, Math.ceil(population / 50)),
        200,
        `${season}:${currentGw}:2`,
      ),
      samplePages(
        2001,
        Math.ceil(population / 50),
        400,
        `${season}:${currentGw}:3`,
      ),
    ];
    const makeWalk = (
      pages: number[],
      stratum: 1 | 2 | 3,
      cursorKey: string,
    ): StratumWalk => ({
      numSteps: pages.length,
      stratum,
      cursorKey,
      pageOf: (index) => pages[index] ?? 0,
    });
    const walkA = makeWalk(plans[0]!, 1, CURSOR_KEY_A),
      walkB = makeWalk(plans[1]!, 2, CURSOR_KEY_B),
      walkC = makeWalk(plans[2]!, 3, CURSOR_KEY_C);

    // Rank-impact endpoints need a score-to-overall-rank curve that remains
    // coherent while matches are live. Refresh it independently from the
    // slower manager-history walk: standings pages contain score and rank in
    // one response, so a published snapshot never mixes Friday ranks with
    // Sunday/Monday totals. A failed refresh keeps the previous good snapshot
    // and must not stop EO/comparison ingestion.
    const rankCurveStarted = Date.now();
    try {
      const rankCurveEvent = await prisma.events.findUnique({
        where: { id: currentGw },
        select: { ranked_count: true, data_checked: true },
      });
      const snapshot = await refreshOverallRankCurveSnapshot({
        gw: currentGw,
        // `finished` flips before all bonus/rank processing is necessarily
        // complete. Keep refreshing until FPL marks the GW data checked.
        isFinal: rankCurveEvent?.data_checked ?? false,
        rankedCount: rankCurveEvent?.ranked_count ?? 0,
      });
      console.info(
        `[populateManagers] overall rank curve GW${currentGw} refreshed from ${snapshot.pagesFetched}/${snapshot.pagesRequested} standings pages (${snapshot.milestones.length} scores, ${Math.round((Date.now() - rankCurveStarted) / 1000)}s)`,
      );
    } catch (err) {
      console.warn(
        `[populateManagers] overall rank curve refresh failed; retaining previous snapshot: ${(err as Error).message}`,
      );
    }

    // One-time migration: pre-refactor cursors stored raw page numbers,
    // which would be silently misread as iteration indices by the new
    // walk logic (e.g. cursor=5000 in v1 meant "page 5000", in v2 means
    // "step 5000 within the walk"). Reset all three cursors on first
    // run after the format bump so the new walks start fresh.
    const cursorVersion = await readIntCursor(CURSOR_FORMAT_KEY, 0);
    const sampleGw = await readIntCursor(SAMPLE_GW_KEY, 0);
    const sampleGwFinalized = await readIntCursor(SAMPLE_GW_FINALIZED_KEY, 0);
    const sampleGwCleaned = await readIntCursor(SAMPLE_GW_CLEANED_KEY, 0);
    // Always clear a newly entered GW before sampling it. Besides removing
    // any user-lazy rows fetched before this cron pass, this prevents an old
    // season's same-numbered GW cache from being treated as current data.
    // Live-GW rows are partial. Once that same GW becomes finished, drop
    // the partial current-GW sample and rebuild it from finalized FPL data.
    const needsCurrentGwSampleReset = shouldResetCurrentGwSample({
      sampleGw,
      currentGw,
      isLiveCurrentGw,
      sampleGwFinalized,
      sampleGwCleaned,
    });
    if (
      cursorVersion < CURRENT_CURSOR_FORMAT_VERSION ||
      needsCurrentGwSampleReset
    ) {
      console.info(
        `[populateManagers] Cursor format ${cursorVersion} → ${CURRENT_CURSOR_FORMAT_VERSION}: resetting walk cursors.`,
      );
      if (
        needsCurrentGwSampleReset ||
        cursorVersion < CURRENT_CURSOR_FORMAT_VERSION
      ) {
        await clearCurrentGwSampleRows(currentGw);
        await writeIntCursor(SAMPLE_GW_CLEANED_KEY, currentGw);
      }
      await writeIntCursor(CURSOR_KEY_A, 0);
      await writeIntCursor(CURSOR_KEY_B, 0);
      await writeIntCursor(CURSOR_KEY_C, 0);
      await writeIntCursor(SAMPLE_GW_KEY, currentGw);
      await writeIntCursor(SAMPLE_GW_FINALIZED_KEY, isLiveCurrentGw ? 0 : 2);
      await writeIntCursor(CURSOR_FORMAT_KEY, CURRENT_CURSOR_FORMAT_VERSION);
    }
    const forceRefreshCurrentGw =
      !isLiveCurrentGw &&
      (await readIntCursor(SAMPLE_GW_FINALIZED_KEY, 0)) !== 1;

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
    const aDone = !isLiveCurrentGw && aIdx >= walkA.numSteps;
    const bDone = !isLiveCurrentGw && bIdx >= walkB.numSteps;
    const cDone = !isLiveCurrentGw && cIdx >= walkC.numSteps;

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
      // Once C has reached its target for this GW, spend the idle capacity
      // on B so finalization converges in a few cron ticks instead of hours.
      const budgetBCap = cDone ? remainingAfterA : BUDGET_B_WHILE_RUNNING;
      budgetB = Math.min(budgetBCap, remainingAfterA);
    }
    const budgetC = cDone ? 0 : MAX_MANAGERS_PER_RUN - budgetA - budgetB;

    console.info(
      `[populateManagers] Starting: currentGw ${currentGw}${isLiveCurrentGw ? " live" : ""}, A idx ${aIdx}/${walkA.numSteps} (budget ${budgetA}), B idx ${bIdx}/${walkB.numSteps} (budget ${budgetB}), C idx ${cIdx}/${walkC.numSteps} (target ${STRATUM_C_TARGET_MANAGERS}, budget ${budgetC}), samplePicks ${INGEST_SAMPLE_PICKS}, sampleTransfers ${INGEST_SAMPLE_TRANSFERS}`,
    );

    if (budgetA > 0) {
      const target = stats.processed + budgetA;
      await ingestFromStandings({
        walk: walkA,
        budget: target,
        currentGw,
        isLiveCurrentGw,
        forceRefreshCurrentGw,
        governor,
        stats,
      });
    }

    if (!governor.shouldAbort && budgetB > 0) {
      const target = stats.processed + budgetB;
      await ingestFromStandings({
        walk: walkB,
        budget: target,
        currentGw,
        isLiveCurrentGw,
        forceRefreshCurrentGw,
        governor,
        stats,
      });
    }

    if (!governor.shouldAbort && budgetC > 0) {
      const target = stats.processed + budgetC;
      await ingestFromStandings({
        walk: walkC,
        budget: target,
        currentGw,
        isLiveCurrentGw,
        forceRefreshCurrentGw,
        governor,
        stats,
      });
    }

    if (governor.shouldAbort)
      throw new Error(
        "Manager collection stopped after repeated upstream failures",
      );
    if (!isLiveCurrentGw) {
      const [finalAIdx, finalBIdx, finalCIdx] = await Promise.all([
        readIntCursor(CURSOR_KEY_A, 0),
        readIntCursor(CURSOR_KEY_B, 0),
        readIntCursor(CURSOR_KEY_C, 0),
      ]);
      if (
        finalAIdx >= walkA.numSteps &&
        finalBIdx >= walkB.numSteps &&
        finalCIdx >= walkC.numSteps
      ) {
        await writeIntCursor(SAMPLE_GW_FINALIZED_KEY, 1);
      }
    }

    // Refresh manager analytics read models once at the end of an ingest
    // run. Range-score buckets are refreshed for the latest end GW only:
    // this is the hot UI path, and it keeps the cron bounded as the sample
    // grows. Historical end GWs stay available and can be fully refreshed
    // out-of-band via `npm run rebuild-manager-read-models`. Transfer averages
    // refresh for the latest end GW on every successful ingest, so newly
    // collected transfer histories are reflected without a manual backfill.
    if (stats.processed > 0 && !governor.shouldAbort) {
      const readModelsStarted = Date.now();
      try {
        await rebuildManagerReadModels({
          rangeBuckets: "latest",
          // Finished historical exposure snapshots are already published.
          // Rebuilding every GW here spills gigabytes from old sample picks
          // and can exhaust the API/database's shared production filesystem.
          exposureGw: currentGw,
        });
        console.info(
          `[populateManagers] manager read models rebuilt in ${Math.round((Date.now() - readModelsStarted) / 1000)}s`,
        );
      } catch (err) {
        console.error(
          "[populateManagers] manager read model rebuild failed:",
          (err as Error).message,
        );
        throw err;
      }
    } else if (!governor.shouldAbort) {
      await rebuildManagerReadModels({
        rangeBuckets: "latest",
        exposureGw: currentGw,
      });
    }

    if (
      seasonClosureDecision.shouldCloseAfterRun &&
      seasonClosureDecision.season
    ) {
      const finalizationState = await readIntCursor(SAMPLE_GW_FINALIZED_KEY, 0);
      if (!isLiveCurrentGw && finalizationState === 1) {
        await markSeasonClosureJobComplete(
          "manager-ingest",
          seasonClosureDecision.season,
        );
        console.info(
          `[populateManagers] Final manager ingest complete for ${seasonClosureDecision.season}; future runs will skip until the next season reset.`,
        );
      } else {
        console.info(
          `[populateManagers] Season-end grace elapsed, but final GW${currentGw} sample is not finalized yet; keeping cron active.`,
        );
      }
    }

    await prisma.app_metadata.upsert({
      where: { key: "analytics_last_collector_success" },
      create: {
        key: "analytics_last_collector_success",
        value: new Date().toISOString(),
      },
      update: { value: new Date().toISOString() },
    });
    console.info(
      `[populateManagers] Run finished: ${JSON.stringify({ ...stats, aborted: governor.shouldAbort, finalDelayMs: governor.interBatchDelayMs })}`,
    );
  } catch (err) {
    console.error("[populateManagers] Run failed:", (err as Error).message);
    throw err;
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
  try {
    await populateManagers({ abortAfterConsecutiveErrors: 20 });
  } catch {
    process.exitCode = 1;
  }
}
