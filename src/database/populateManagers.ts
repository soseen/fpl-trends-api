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
import { RANK_BAND_SQL_CASE } from "../managers/rankBands.js";
import { fetchEntryTransfers } from "../managers/fetchTransfers.js";
import {
  RateLimitGovernor,
  DEFAULT_GOVERNOR_CONFIG,
  type GovernorConfig,
} from "../managers/rateLimitGovernor.js";
import { delay } from "../utils.js";

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
const STRATUM_C_TARGET_MANAGERS = readEnvInt(
  "MANAGER_STRATUM_C_TARGET_MANAGERS",
  50_000,
  1_000,
);
const STRATUM_C_TARGET_STEPS = Math.min(
  STRATUM_C_NUM_SLOTS,
  Math.ceil(STRATUM_C_TARGET_MANAGERS / 50),
);
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
const MAX_MANAGERS_PER_RUN = readEnvInt("MANAGER_MAX_PER_RUN", 20_000, 1_000);

// Budget split when stratum A is still in progress vs done. A is the top
// 10k (fixed). B with stride 1 has 1800 pages = 90k entries to cover
// per pass; at 5000/cron that's a full pass every ~4.5 hours, fast enough
// to keep stratum tags reasonably fresh. C still gets the largest share
// (extrapolation factor is biggest and new probes are most likely unseen).
const BUDGET_A_WHILE_RUNNING = readEnvInt("MANAGER_BUDGET_A", 2_000, 0);
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
// Bumped when cursor semantics change in a way that pre-existing cursor
// values would be silently misinterpreted or when steady-state enrichment
// needs a one-time same-GW repair pass. v1 = raw page number (pre
// golden-step refactor). v2 = iteration index within a walk's `numSteps`.
// v3 = bounded per-GW sample: completed walks stay complete until GW changes.
// v4 = same-GW repair for chips/current picks after the prod GW35 pass ran
// with sample-pick ingestion disabled.
const CURSOR_FORMAT_KEY = "manager_walk_cursor_version";
const CURRENT_CURSOR_FORMAT_VERSION = 4;
const LOCKFILE_PATH = path.join(os.tmpdir(), "fpl-populate-managers.lock");
// Conservative max age — a normal run is ~13 min, peak ~20 min on heavy
// ticks. Anything past 30 min is stuck: a DB query that's spinning on
// disk pressure, an FPL HTTP call without a timeout, or a hard hang we
// can't otherwise see. We treat it as recoverable and reclaim — see
// isLockStale below.
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
): Promise<ProcessOutcome> => {
  const existing = await prisma.manager_summary.findUnique({
    where: { entry_id: entryId },
    select: {
      last_checked_gw: true,
      has_chip_history: true,
      has_transfer_history: true,
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
    currentGwPicksComplete &&
    !needsTransferHistory
  ) {
    return "skipped";
  }

  let history;
  try {
    history = await withGovernor(governor, () => fetchEntryHistory(entryId));
  } catch {
    if (governor.shouldAbort) throw new Error("governor_aborted");
    // Record the visit even on fetch failure so we don't retry every cron
    // tick — last_checked_gw=currentGw skips this entry until the next GW
    // transition. Equivalent to the old "rejected_reason='fetch_failed'"
    // marker but without the column: an entry with a manager_summary row
    // but no manager_history rows is naturally absent from sample queries.
    await prisma.manager_summary.upsert({
      where: { entry_id: entryId },
      update: {
        overall_rank: overallRank,
        total_points: totalPoints,
        stratum,
        last_checked_gw: currentGw,
      },
      create: {
        entry_id: entryId,
        overall_rank: overallRank,
        total_points: totalPoints,
        stratum,
        last_checked_gw: currentGw,
      },
    });
    return "fetch_failed";
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
  for (const ev of history.current ?? []) {
    await prisma.manager_history.upsert({
      where: { entry_id_gw: { entry_id: entryId, gw: ev.event } },
      update: {
        points: netPointsForEvent(ev),
        event_transfers: ev.event_transfers,
        event_transfers_cost: ev.event_transfers_cost,
        points_on_bench: ev.points_on_bench,
        active_chip: chipByGw.get(ev.event) ?? null,
      },
      create: {
        entry_id: entryId,
        gw: ev.event,
        points: netPointsForEvent(ev),
        event_transfers: ev.event_transfers,
        event_transfers_cost: ev.event_transfers_cost,
        points_on_bench: ev.points_on_bench,
        active_chip: chipByGw.get(ev.event) ?? null,
      },
    });
  }

  // Fill in the latest sampled GW for captaincy and EO. During live GWs this
  // is the current GW, so My Trends can converge while matches are still
  // being played.
  if (INGEST_SAMPLE_PICKS) {
    await ingestPicksForMissingGws(entryId, currentGw, governor);
  }

  // Rebuild manager_cumulative for this entry after optional picks are current
  // so captain-derived running fields are reflected immediately. Chip fields
  // come from manager_history.active_chip, stored from the history payload.
  await rebuildCumulativeForEntry(entryId, stratum);

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
const CHIP_HALVES_BOUNDARY = 19;

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
// canonical. Stratum is denormalised onto every row so the read path
// needs no manager_summary join.
//
// Captain bonus joins manager_picks for the entry and the footballers'
// `history` table for the captained player's GW points. For GWs where
// picks haven't been ingested yet (the typical case before backfillPicks
// has run for this entry's earlier GWs), the LEFT JOIN yields NULL and
// the contribution is 0 — the comparison endpoint's sample average is
// best-effort and converges as picks are filled in over subsequent
// processEntry visits.
export const rebuildCumulativeForEntry = async (
  entryId: number,
  stratum: 1 | 2 | 3,
): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`DELETE FROM manager_cumulative WHERE entry_id = ${entryId}`;
    await tx.$executeRawUnsafe(
      `
      INSERT INTO manager_cumulative
        (entry_id, gw, cumulative_points, cumulative_transfers,
         cumulative_hits_cost, cumulative_bench, cumulative_captain_bonus,
         gws_played,
         chip_wildcard_h1, chip_wildcard_h2,
         chip_freehit_h1,  chip_freehit_h2,
         chip_bboost_h1,   chip_bboost_h2,
         has_transfers, has_hits, has_bench,
         picks_count_cum,
         stratum)
      SELECT
        base.entry_id, base.gw,
        (SUM(base.points)                            OVER w)::int AS cumulative_points,
        (SUM(COALESCE(base.event_transfers,      0)) OVER w)::int AS cumulative_transfers,
        (SUM(COALESCE(base.event_transfers_cost, 0)) OVER w)::int AS cumulative_hits_cost,
        (SUM(COALESCE(base.points_on_bench,      0)) OVER w)::int AS cumulative_bench,
        (SUM(base.captain_bonus)                     OVER w)::int AS cumulative_captain_bonus,
        (COUNT(*)                                    OVER w)::int AS gws_played,
        -- active_chip comes from entry history. Null means no chip that GW.
        BOOL_OR(COALESCE(base.active_chip = 'wildcard' AND base.gw <= $3, false)) OVER w AS chip_wildcard_h1,
        BOOL_OR(COALESCE(base.active_chip = 'wildcard' AND base.gw  > $3, false)) OVER w AS chip_wildcard_h2,
        BOOL_OR(COALESCE(base.active_chip = 'freehit'  AND base.gw <= $3, false)) OVER w AS chip_freehit_h1,
        BOOL_OR(COALESCE(base.active_chip = 'freehit'  AND base.gw  > $3, false)) OVER w AS chip_freehit_h2,
        BOOL_OR(COALESCE(base.active_chip = 'bboost'   AND base.gw <= $3, false)) OVER w AS chip_bboost_h1,
        BOOL_OR(COALESCE(base.active_chip = 'bboost'   AND base.gw  > $3, false)) OVER w AS chip_bboost_h2,
        BOOL_OR(base.event_transfers      IS NOT NULL) OVER w AS has_transfers,
        BOOL_OR(base.event_transfers_cost IS NOT NULL) OVER w AS has_hits,
        BOOL_OR(base.points_on_bench      IS NOT NULL) OVER w AS has_bench,
        (SUM(base.has_picks)                         OVER w)::int AS picks_count_cum,
        $2
      FROM (
        SELECT
          mh.entry_id, mh.gw, mh.points,
          mh.event_transfers, mh.event_transfers_cost, mh.points_on_bench,
          mh.active_chip,
          CASE WHEN mp.gw IS NOT NULL THEN 1 ELSE 0 END AS has_picks,
          COALESCE(
            CASE
              WHEN mp.captain_multiplier IS NOT NULL AND mp.captain_multiplier > 1 THEN
                (SELECT SUM(h.total_points)::int
                   FROM history h
                   WHERE h.footballer_id = mp.captain_element AND h.round = mh.gw)
                * (mp.captain_multiplier - 1)
              ELSE 0
            END,
            0
          ) AS captain_bonus
        FROM manager_history mh
        LEFT JOIN manager_picks mp
          ON mp.entry_id = mh.entry_id AND mp.gw = mh.gw
        WHERE mh.entry_id = $1
      ) base
      WINDOW w AS (PARTITION BY base.entry_id ORDER BY base.gw)
      ORDER BY base.gw
      `,
      entryId,
      stratum,
      CHIP_HALVES_BOUNDARY,
    );
  });
};

// Inline picks ingestion: fetch picks for the latest sampled GW only,
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

  const [existing, elementRows] = await Promise.all([
    prisma.manager_picks.findUnique({
      where: { entry_id_gw: { entry_id: entryId, gw: currentGw } },
      select: { gw: true },
    }),
    prisma.manager_pick_elements.count({
      where: { entry_id: entryId, gw: currentGw },
    }),
  ]);
  if (existing && elementRows >= 15) return;

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
  } catch {
    // Persistent failure — leave the flag false; next visit retries.
    return;
  }

  // Single multi-row insert with ON CONFLICT … DO NOTHING — append-only
  // semantics, matches the unique-by-construction (entry_id, gw, in, out)
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
  numSteps: STRATUM_C_TARGET_STEPS,
  pageOf: stratumCPageForIndex,
  stratum: 3,
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
              isLiveCurrentGw,
              forceRefreshCurrentGw,
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
      `[populateManagers] Stratum ${walk.stratum} complete for this GW.`,
    );
    await writeIntCursor(walk.cursorKey, isLiveCurrentGw ? 0 : walk.numSteps);
  }
};

// Rebuild the (stratum, gw, captain_element, captain_multiplier) aggregate
// table used by getTeamImpact.fetchCaptainRatesInStratum and
// getManagerComparison.sampleMostCaptained. Single TRUNCATE+INSERT inside
// a transaction so readers always see a consistent snapshot — no partial
// state where some captains/GWs are missing.
//
// Exported so rebuildManagerReadModels can call this out-of-band (e.g.
// immediately after deploying the schema, before the next populate cron
// tick).
export const rebuildStratumCaptainPicks = async (): Promise<void> => {
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`TRUNCATE stratum_captain_picks_gw`),
    prisma.$executeRawUnsafe(`
      INSERT INTO stratum_captain_picks_gw
        (stratum, gw, captain_element, captain_multiplier, picks, last_rebuilt)
      SELECT
        ms.stratum,
        mp.gw,
        mp.captain_element,
        mp.captain_multiplier,
        COUNT(*)::int AS picks,
        NOW()         AS last_rebuilt
      FROM manager_picks mp
      JOIN manager_summary ms ON ms.entry_id = mp.entry_id
      WHERE mp.captain_element IS NOT NULL
        AND mp.captain_multiplier IS NOT NULL
      GROUP BY ms.stratum, mp.gw, mp.captain_element, mp.captain_multiplier
    `),
  ]);
};

// Rebuild LiveFPL-style player exposure by rank band from full XV rows.
// The important metric is effective_multiplier_sum / sample_size, which is
// actual EO from final multipliers rather than global selected-by plus a
// separate captain estimate.
export const rebuildRankBandPlayerExposure = async (): Promise<void> => {
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`TRUNCATE rank_band_player_exposure_gw`),
    prisma.$executeRawUnsafe(`
      INSERT INTO rank_band_player_exposure_gw
        (rank_band, gw, element_id, sample_size, squad_picks, active_picks,
         effective_multiplier_sum, last_rebuilt)
      WITH pick_rows AS (
        SELECT
          ${RANK_BAND_SQL_CASE} AS rank_band,
          mpe.gw,
          mpe.entry_id,
          mpe.element_id,
          mpe.multiplier
        FROM manager_pick_elements mpe
        JOIN manager_summary ms ON ms.entry_id = mpe.entry_id
        WHERE ms.overall_rank IS NOT NULL
      ),
      samples AS (
        SELECT
          rank_band,
          gw,
          COUNT(DISTINCT entry_id)::int AS sample_size
        FROM pick_rows
        WHERE rank_band IS NOT NULL
        GROUP BY rank_band, gw
      ),
      player_exposure AS (
        SELECT
          rank_band,
          gw,
          element_id,
          COUNT(*)::int AS squad_picks,
          COUNT(*) FILTER (WHERE multiplier > 0)::int AS active_picks,
          COALESCE(SUM(multiplier), 0)::int AS effective_multiplier_sum
        FROM pick_rows
        WHERE rank_band IS NOT NULL
        GROUP BY rank_band, gw, element_id
      )
      SELECT
        pe.rank_band,
        pe.gw,
        pe.element_id,
        s.sample_size,
        pe.squad_picks,
        pe.active_picks,
        pe.effective_multiplier_sum,
        NOW() AS last_rebuilt
      FROM player_exposure pe
      JOIN samples s ON s.rank_band = pe.rank_band AND s.gw = pe.gw
    `),
  ]);
};

// Rebuild the (stratum, gw) running-stats table used by
// getManagerComparison.sampleStratumAggregates. Single TRUNCATE+INSERT
// inside a transaction so readers always see a consistent snapshot — no
// partial state where some (stratum, gw) buckets are missing.
//
// Tiny output: 3 strata × ≤38 GWs = ≤114 rows. The expensive part is the
// GROUP BY over manager_cumulative (~75M rows on prod) — typically ~30–60s
// on the prod CX23. This runs once per cron cycle (15 min cadence), not
// per request, which is the entire point: the per-request DISTINCT ON
// over the same partition is what was costing 15–25 s on cold cache.
//
// Population filter (stable_managers CTE): the read path subtracts
// (sum at end_gw) − (sum at start_gw − 1). That subtraction is only
// well-defined when the SAME set of managers contributes to both
// endpoints. Without a filter, managers whose latest manager_cumulative
// row is some past GW (ingested weeks ago, not yet re-walked) contribute
// to the start anchor but not the end, producing negative deltas in
// sampleStratumAggregates. The CTE restricts every (stratum, gw) row to
// managers who have a row at the current max GW — i.e. the cohort that
// is actually up-to-date — so the subtraction is well-defined.
//
// Exported so rebuildManagerReadModels can call this out-of-band (e.g.
// immediately after applying the schema migration so the new read path
// has a populated table to read from before the next 15-minute populate
// tick).
export const rebuildStratumGwRunningStats = async (): Promise<void> => {
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`TRUNCATE stratum_gw_running_stats`),
    prisma.$executeRawUnsafe(`
      WITH current_max AS (
        SELECT MAX(gw) AS gw FROM manager_cumulative
      ),
      stable_managers AS (
        SELECT mc.entry_id
        FROM manager_cumulative mc
        JOIN current_max cm ON mc.gw = cm.gw
      )
      INSERT INTO stratum_gw_running_stats
        (stratum, gw, sample_size,
         sum_cum_points, sum_cum_transfers, sum_cum_hits_cost,
         sum_cum_bench, sum_cum_captain_bonus, sum_gws_played,
         count_with_transfers, count_with_hits, count_with_bench,
         count_with_chips,
         cum_wildcards_h1, cum_wildcards_h2,
         cum_freehits_h1,  cum_freehits_h2,
         cum_bboosts_h1,   cum_bboosts_h2,
         last_rebuilt)
      SELECT
        mc.stratum,
        mc.gw,
        COUNT(*)::int                                              AS sample_size,
        SUM(mc.cumulative_points)::bigint                          AS sum_cum_points,
        SUM(mc.cumulative_transfers)::bigint                       AS sum_cum_transfers,
        SUM(mc.cumulative_hits_cost)::bigint                       AS sum_cum_hits_cost,
        SUM(mc.cumulative_bench)::bigint                           AS sum_cum_bench,
        SUM(mc.cumulative_captain_bonus)::bigint                   AS sum_cum_captain_bonus,
        SUM(mc.gws_played)::bigint                                 AS sum_gws_played,
        COUNT(*) FILTER (WHERE mc.has_transfers)::int              AS count_with_transfers,
        COUNT(*) FILTER (WHERE mc.has_hits)::int                   AS count_with_hits,
        COUNT(*) FILTER (WHERE mc.has_bench)::int                  AS count_with_bench,
        COUNT(*) FILTER (WHERE ms.has_chip_history)::int           AS count_with_chips,
        COUNT(*) FILTER (WHERE mc.chip_wildcard_h1)::int           AS cum_wildcards_h1,
        COUNT(*) FILTER (WHERE mc.chip_wildcard_h2)::int           AS cum_wildcards_h2,
        COUNT(*) FILTER (WHERE mc.chip_freehit_h1)::int            AS cum_freehits_h1,
        COUNT(*) FILTER (WHERE mc.chip_freehit_h2)::int            AS cum_freehits_h2,
        COUNT(*) FILTER (WHERE mc.chip_bboost_h1)::int             AS cum_bboosts_h1,
        COUNT(*) FILTER (WHERE mc.chip_bboost_h2)::int             AS cum_bboosts_h2,
        NOW()                                                      AS last_rebuilt
      FROM manager_cumulative mc
      JOIN stable_managers sm ON sm.entry_id = mc.entry_id
      JOIN manager_summary ms ON ms.entry_id = mc.entry_id
      GROUP BY mc.stratum, mc.gw
    `),
  ]);
};

// Per-(stratum, start_gw, end_gw) precomputed avg net points per transfer.
// Replaces the per-request sampleAvgPtsPerTransfer query that dominated
// comparison-endpoint latency. See stratum_range_xfer_avg in schema.prisma
// for the model and read-path semantics.
//
// Two modes:
//   - `endGwOnly` (cron): refresh only the rows for end_gw=currentGw.
//     The aggregation cost scales with one end_gw column (~currentGw rows ×
//     3 strata) instead of the full grid (~currentGw²/2 rows × 3). Older
//     end_gws are left in place — they drift slightly as new managers
//     ingest, but the drift is bounded (~few percent per cron) and a manual
//     backfill resyncs.
//   - no args (backfill): full rebuild of every (start_gw, end_gw) row.
//     TRUNCATE then INSERT one (start_gw, end_gw) at a time so each query's
//     working set stays bounded; total runtime is ~10-30 min on prod.
//
// Each per-(start_gw, end_gw) INSERT is structurally the same query that
// sampleAvgPtsPerTransfer ran per request, just executed once per range
// instead of once per request. The FULL stratum-3 ingested sample is used
// (no entry_id % 32 sub-sample), which improves precision vs the previous
// request-time path.
export const rebuildStratumRangeXferAvg = async (options?: {
  endGwOnly?: number;
}): Promise<void> => {
  const sampledGw = await prisma.manager_cumulative.aggregate({
    _max: { gw: true },
  });
  const maxGw = sampledGw._max.gw ?? 0;
  if (maxGw < 1) {
    if (options?.endGwOnly === undefined) {
      await prisma.$executeRawUnsafe(`TRUNCATE stratum_range_xfer_avg`);
    }
    return;
  }

  const endGws =
    options?.endGwOnly !== undefined
      ? options.endGwOnly >= 1 && options.endGwOnly <= maxGw
        ? [options.endGwOnly]
        : []
      : Array.from({ length: maxGw }, (_, i) => i + 1);

  if (options?.endGwOnly === undefined) {
    await prisma.$executeRawUnsafe(`TRUNCATE stratum_range_xfer_avg`);
  } else if (endGws.length > 0) {
    // Brief inconsistency window (~1-3s per start_gw) where readers see
    // missing rows for this end_gw column. Acceptable: read path returns
    // null for missing rows, which the UI renders the same as
    // not-enough-data. UPSERT would avoid the window but complicates the
    // SQL; the gap is small enough not to bother.
    await prisma.$executeRawUnsafe(
      `DELETE FROM stratum_range_xfer_avg WHERE end_gw = $1`,
      options.endGwOnly,
    );
  }

  for (const endGw of endGws) {
    for (let startGw = 1; startGw <= endGw; startGw++) {
      await prisma.$executeRawUnsafe(
        `
        INSERT INTO stratum_range_xfer_avg
          (stratum, start_gw, end_gw, sum_per_manager_avg, managers_with_xfers,
           with_data, stratum_size, last_rebuilt)
        WITH point_windows AS (
          SELECT h.footballer_id, gw_series.gw,
                 SUM(h.total_points)::float AS pts
          FROM generate_series($1::int, $2::int) AS gw_series(gw)
          JOIN history h ON h.round BETWEEN gw_series.gw AND $2::int
          GROUP BY h.footballer_id, gw_series.gw
        ),
        per_manager AS (
          SELECT mt.entry_id, ms.stratum,
                 SUM(COALESCE(in_pts.pts, 0) - COALESCE(out_pts.pts, 0))::float AS net,
                 COUNT(*)::int AS xfers
          FROM manager_transfers mt
          JOIN manager_summary ms ON ms.entry_id = mt.entry_id
          LEFT JOIN point_windows in_pts
            ON in_pts.footballer_id = mt.in_element AND in_pts.gw = mt.gw
          LEFT JOIN point_windows out_pts
            ON out_pts.footballer_id = mt.out_element AND out_pts.gw = mt.gw
          WHERE mt.gw BETWEEN $1::int AND $2::int
            AND ms.stratum IN (1, 2, 3)
          GROUP BY mt.entry_id, ms.stratum
        ),
        agg AS (
          SELECT stratum,
                 SUM(net / NULLIF(xfers, 0))::float AS sum_per_manager_avg,
                 COUNT(*)::int AS managers_with_xfers
          FROM per_manager
          WHERE xfers > 0
          GROUP BY stratum
        ),
        sizes AS (
          SELECT stratum,
                 COUNT(*) FILTER (WHERE has_transfer_history)::int AS with_data,
                 COUNT(*)::int AS stratum_size
          FROM manager_summary
          WHERE stratum IN (1, 2, 3)
          GROUP BY stratum
        ),
        strata AS (SELECT unnest(ARRAY[1, 2, 3]::int[]) AS stratum)
        SELECT
          st.stratum,
          $1::int,
          $2::int,
          COALESCE(a.sum_per_manager_avg, 0)::float,
          COALESCE(a.managers_with_xfers, 0)::int,
          COALESCE(sz.with_data, 0)::int,
          COALESCE(sz.stratum_size, 0)::int,
          NOW()
        FROM strata st
        LEFT JOIN sizes sz ON sz.stratum = st.stratum
        LEFT JOIN agg a ON a.stratum = st.stratum
        `,
        startGw,
        endGw,
      );
    }
  }
};

type RangeScoreBucketRebuildOptions = {
  endGwOnly?: number;
};

const rebuildManagerRangeScoreBucketsForEndGw = async (
  endGw: number,
): Promise<void> => {
  await prisma.$transaction([
    prisma.$executeRawUnsafe(
      `DROP TABLE IF EXISTS tmp_manager_range_bucket_end`,
    ),
    prisma.$executeRawUnsafe(
      `DROP TABLE IF EXISTS tmp_manager_range_bucket_start`,
    ),
    prisma.$executeRaw`
      CREATE TEMP TABLE tmp_manager_range_bucket_end
      ON COMMIT DROP
      AS
      SELECT entry_id, stratum, cumulative_points
      FROM manager_cumulative
      WHERE gw = ${endGw}
    `,
    prisma.$executeRaw`
      CREATE TEMP TABLE tmp_manager_range_bucket_start
      ON COMMIT DROP
      AS
      SELECT c.entry_id, c.gw, c.cumulative_points
      FROM manager_cumulative c
      JOIN tmp_manager_range_bucket_end e ON e.entry_id = c.entry_id
      WHERE c.gw >= 1 AND c.gw < ${endGw}
    `,
    prisma.$executeRawUnsafe(
      `CREATE INDEX tmp_manager_range_bucket_start_idx
       ON tmp_manager_range_bucket_start (entry_id, gw)`,
    ),
    prisma.$executeRawUnsafe(`ANALYZE tmp_manager_range_bucket_end`),
    prisma.$executeRawUnsafe(`ANALYZE tmp_manager_range_bucket_start`),
    prisma.$executeRaw`
      DELETE FROM manager_range_score_buckets
      WHERE end_gw = ${endGw}
    `,
    prisma.$executeRaw`
      INSERT INTO manager_range_score_buckets
        (stratum, start_gw, end_gw, range_total, managers, last_rebuilt)
      WITH starts AS (
        SELECT generate_series(1, ${endGw})::int AS start_gw
      )
      SELECT
        c_end.stratum,
        starts.start_gw,
        ${endGw}::int AS end_gw,
        (c_end.cumulative_points - COALESCE(c_start.cumulative_points, 0))::int
          AS range_total,
        COUNT(*)::int AS managers,
        NOW() AS last_rebuilt
      FROM tmp_manager_range_bucket_end c_end
      CROSS JOIN starts
      LEFT JOIN tmp_manager_range_bucket_start c_start
        ON c_start.entry_id = c_end.entry_id
       AND c_start.gw = starts.start_gw - 1
      GROUP BY
        c_end.stratum,
        starts.start_gw,
        c_end.cumulative_points - COALESCE(c_start.cumulative_points, 0)
    `,
  ]);
};

export const rebuildManagerRangeScoreBuckets = async ({
  endGwOnly,
}: RangeScoreBucketRebuildOptions = {}): Promise<void> => {
  const sampledGw = await prisma.manager_cumulative.aggregate({
    _max: { gw: true },
  });
  const currentGw = sampledGw._max.gw ?? (await getCurrentSampleGameweek()).gw;
  if (currentGw < 1) {
    await prisma.$executeRawUnsafe(`TRUNCATE manager_range_score_buckets`);
    return;
  }

  if (endGwOnly !== undefined) {
    const endGw = Math.min(Math.max(endGwOnly, 1), currentGw);
    await rebuildManagerRangeScoreBucketsForEndGw(endGw);
    return;
  }

  await prisma.$executeRaw`
    DELETE FROM manager_range_score_buckets
    WHERE end_gw > ${currentGw}
  `;
  for (let endGw = 1; endGw <= currentGw; endGw += 1) {
    await rebuildManagerRangeScoreBucketsForEndGw(endGw);
  }
};

export const rangeScoreBucketsNeedRefresh = async (
  endGw: number,
): Promise<boolean> => {
  const rows = await prisma.$queryRaw<
    Array<{
      cumulative_sample: number;
      bucket_sample: number;
    }>
  >`
    WITH cumulative AS (
      SELECT stratum, COUNT(*)::int AS sample_size
      FROM manager_cumulative
      WHERE gw = ${endGw}
      GROUP BY stratum
    ),
    buckets AS (
      SELECT stratum, SUM(managers)::int AS sample_size
      FROM manager_range_score_buckets
      WHERE start_gw = 1 AND end_gw = ${endGw}
      GROUP BY stratum
    )
    SELECT
      COALESCE(c.sample_size, 0)::int AS cumulative_sample,
      COALESCE(b.sample_size, 0)::int AS bucket_sample
    FROM cumulative c
    FULL OUTER JOIN buckets b ON b.stratum = c.stratum
  `;

  return rows.some((row) => row.cumulative_sample !== row.bucket_sample);
};

type ManagerReadModelRebuildOptions = {
  rangeBuckets?: "all" | "latest";
};

export const rebuildManagerReadModels = async ({
  rangeBuckets = "all",
}: ManagerReadModelRebuildOptions = {}): Promise<void> => {
  const captainStarted = Date.now();
  await rebuildStratumCaptainPicks();
  console.info(
    `[populateManagers] stratum_captain_picks_gw rebuilt in ${Math.round((Date.now() - captainStarted) / 1000)}s`,
  );

  const exposureStarted = Date.now();
  await rebuildRankBandPlayerExposure();
  console.info(
    `[populateManagers] rank_band_player_exposure_gw rebuilt in ${Math.round((Date.now() - exposureStarted) / 1000)}s`,
  );

  const runningStarted = Date.now();
  await rebuildStratumGwRunningStats();
  console.info(
    `[populateManagers] stratum_gw_running_stats rebuilt in ${Math.round((Date.now() - runningStarted) / 1000)}s`,
  );

  const bucketStarted = Date.now();
  const sampledGw = await prisma.manager_cumulative.aggregate({
    _max: { gw: true },
  });
  const currentGw = sampledGw._max.gw ?? 0;
  await rebuildManagerRangeScoreBuckets(
    rangeBuckets === "latest" && currentGw >= 1
      ? { endGwOnly: currentGw }
      : undefined,
  );
  console.info(
    `[populateManagers] manager_range_score_buckets rebuilt${rangeBuckets === "latest" && currentGw >= 1 ? ` (end_gw=${currentGw})` : ""} in ${Math.round((Date.now() - bucketStarted) / 1000)}s`,
  );

  // Refresh only the latest end_gw column of stratum_range_xfer_avg —
  // older end_gws drift slowly and are kept fresh by the manual backfill
  // script (npm run backfill-stratum-range-xfer-avg). Full rebuild here
  // would add ~10-30 min to every cron tick, blowing past the 15-min
  // cycle budget. End_gw=current is what most users query (default UI
  // ranges anchor at the current GW), so this is where freshness matters
  // most.
  const xferStarted = Date.now();
  if (currentGw >= 1) {
    await rebuildStratumRangeXferAvg({ endGwOnly: currentGw });
    console.info(
      `[populateManagers] stratum_range_xfer_avg (end_gw=${currentGw}) rebuilt in ${Math.round((Date.now() - xferStarted) / 1000)}s`,
    );
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
    const { gw: currentGw, isLive: isLiveCurrentGw } =
      await getCurrentSampleGameweek();
    if (currentGw < 1) {
      console.warn(
        "[populateManagers] No active or finished GWs yet - nothing to ingest.",
      );
      return;
    }

    // One-time migration: pre-refactor cursors stored raw page numbers,
    // which would be silently misread as iteration indices by the new
    // walk logic (e.g. cursor=5000 in v1 meant "page 5000", in v2 means
    // "step 5000 within the walk"). Reset all three cursors on first
    // run after the format bump so the new walks start fresh.
    const cursorVersion = await readIntCursor(CURSOR_FORMAT_KEY, 0);
    const sampleGw = await readIntCursor(SAMPLE_GW_KEY, 0);
    const sampleGwFinalized = await readIntCursor(SAMPLE_GW_FINALIZED_KEY, 0);
    const needsFinalizedPass =
      !isLiveCurrentGw && sampleGw === currentGw && sampleGwFinalized === 0;
    if (
      cursorVersion < CURRENT_CURSOR_FORMAT_VERSION ||
      sampleGw !== currentGw ||
      needsFinalizedPass
    ) {
      console.info(
        `[populateManagers] Cursor format ${cursorVersion} → ${CURRENT_CURSOR_FORMAT_VERSION}: resetting walk cursors.`,
      );
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
    const aDone = !isLiveCurrentGw && aIdx >= STRATUM_A_WALK.numSteps;
    const bDone = !isLiveCurrentGw && bIdx >= STRATUM_B_WALK.numSteps;
    const cDone = !isLiveCurrentGw && cIdx >= STRATUM_C_WALK.numSteps;

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
    const budgetC = cDone ? 0 : MAX_MANAGERS_PER_RUN - budgetA - budgetB;

    console.info(
      `[populateManagers] Starting: currentGw ${currentGw}${isLiveCurrentGw ? " live" : ""}, A idx ${aIdx}/${STRATUM_A_WALK.numSteps} (budget ${budgetA}), B idx ${bIdx}/${STRATUM_B_WALK.numSteps} (budget ${budgetB}), C idx ${cIdx}/${STRATUM_C_WALK.numSteps} (target ${STRATUM_C_TARGET_MANAGERS}, budget ${budgetC}), samplePicks ${INGEST_SAMPLE_PICKS}, sampleTransfers ${INGEST_SAMPLE_TRANSFERS}`,
    );

    if (budgetA > 0) {
      const target = stats.processed + budgetA;
      await ingestFromStandings({
        walk: STRATUM_A_WALK,
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
        walk: STRATUM_B_WALK,
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
        walk: STRATUM_C_WALK,
        budget: target,
        currentGw,
        isLiveCurrentGw,
        forceRefreshCurrentGw,
        governor,
        stats,
      });
    }

    if (!isLiveCurrentGw) {
      const [finalAIdx, finalBIdx, finalCIdx] = await Promise.all([
        readIntCursor(CURSOR_KEY_A, 0),
        readIntCursor(CURSOR_KEY_B, 0),
        readIntCursor(CURSOR_KEY_C, 0),
      ]);
      if (
        finalAIdx >= STRATUM_A_WALK.numSteps &&
        finalBIdx >= STRATUM_B_WALK.numSteps &&
        finalCIdx >= STRATUM_C_WALK.numSteps
      ) {
        await writeIntCursor(SAMPLE_GW_FINALIZED_KEY, 1);
      }
    }

    // Refresh manager analytics read models once at the end of an ingest
    // run. Range-score buckets are refreshed for the latest end GW only:
    // this is the hot UI path, and it keeps the cron bounded as the sample
    // grows. Historical end GWs stay available and can be fully refreshed
    // out-of-band via `npm run rebuild-manager-read-models`.
    if (stats.processed > 0 && !governor.shouldAbort) {
      const readModelsStarted = Date.now();
      try {
        await rebuildManagerReadModels({ rangeBuckets: "latest" });
        console.info(
          `[populateManagers] manager read models rebuilt in ${Math.round((Date.now() - readModelsStarted) / 1000)}s`,
        );
      } catch (err) {
        console.error(
          "[populateManagers] manager read model rebuild failed:",
          (err as Error).message,
        );
      }
    } else if (!governor.shouldAbort) {
      const bucketStale =
        currentGw >= 1 && (await rangeScoreBucketsNeedRefresh(currentGw));
      if (bucketStale) {
        const bucketStarted = Date.now();
        try {
          await rebuildManagerRangeScoreBuckets({ endGwOnly: currentGw });
          console.info(
            `[populateManagers] manager_range_score_buckets repaired (end_gw=${currentGw}) in ${Math.round((Date.now() - bucketStarted) / 1000)}s`,
          );
        } catch (err) {
          console.error(
            "[populateManagers] manager range bucket repair failed:",
            (err as Error).message,
          );
        }
      }
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
