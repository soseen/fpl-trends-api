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
import { fetchEntryTransfers } from "../managers/fetchTransfers.js";
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
    },
    create: {
      entry_id: entryId,
      overall_rank: overallRank,
      total_points: totalPoints,
      stratum,
      last_checked_gw: currentGw,
    },
  });

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
  await rebuildCumulativeForEntry(entryId, stratum);

  // Picks ingestion: fill in any (entry_id, gw) we don't already have for
  // finished GWs. This is the steady-state path; bulk backfill lives in
  // `backfillPicks.ts` so a heavy historic re-fetch can run separately
  // without blocking the cron.
  await ingestPicksForMissingGws(entryId, currentGw, governor);

  // Transfers ingestion: one HTTP call per manager, but only on the first
  // visit (gated by manager_summary.has_transfer_history). Transfers grow
  // append-only, but mid-season managers will accumulate them — refetch
  // when last_checked_gw advances so the sample stays current. The
  // existing skip-on-no-change check at the top of processEntry already
  // covers the common case (no work for an entry visited this same GW).
  await ingestTransfersForEntry(entryId, governor);

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
const rebuildCumulativeForEntry = async (
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
         stratum)
      SELECT
        base.entry_id, base.gw,
        (SUM(base.points)                            OVER w)::int AS cumulative_points,
        (SUM(COALESCE(base.event_transfers,      0)) OVER w)::int AS cumulative_transfers,
        (SUM(COALESCE(base.event_transfers_cost, 0)) OVER w)::int AS cumulative_hits_cost,
        (SUM(COALESCE(base.points_on_bench,      0)) OVER w)::int AS cumulative_bench,
        (SUM(base.captain_bonus)                     OVER w)::int AS cumulative_captain_bonus,
        (COUNT(*)                                    OVER w)::int AS gws_played,
        -- COALESCE to FALSE: when manager_picks is missing for a (entry, gw),
        -- active_chip is NULL via LEFT JOIN, and (NULL = 'wildcard') is NULL.
        -- For h1 (gw <= 19) the AND with TRUE leaves NULL; BOOL_OR over an
        -- all-NULL partition then returns NULL, which violates the NOT NULL
        -- constraint on the chip columns. Coercing to FALSE pre-aggregate
        -- keeps the read-path semantics correct (an entry with no picks for
        -- the GW didn't play that chip) and the column non-null.
        BOOL_OR(COALESCE(base.active_chip = 'wildcard' AND base.gw <= $3, false)) OVER w AS chip_wildcard_h1,
        BOOL_OR(COALESCE(base.active_chip = 'wildcard' AND base.gw  > $3, false)) OVER w AS chip_wildcard_h2,
        BOOL_OR(COALESCE(base.active_chip = 'freehit'  AND base.gw <= $3, false)) OVER w AS chip_freehit_h1,
        BOOL_OR(COALESCE(base.active_chip = 'freehit'  AND base.gw  > $3, false)) OVER w AS chip_freehit_h2,
        BOOL_OR(COALESCE(base.active_chip = 'bboost'   AND base.gw <= $3, false)) OVER w AS chip_bboost_h1,
        BOOL_OR(COALESCE(base.active_chip = 'bboost'   AND base.gw  > $3, false)) OVER w AS chip_bboost_h2,
        BOOL_OR(base.event_transfers      IS NOT NULL) OVER w AS has_transfers,
        BOOL_OR(base.event_transfers_cost IS NOT NULL) OVER w AS has_hits,
        BOOL_OR(base.points_on_bench      IS NOT NULL) OVER w AS has_bench,
        $2
      FROM (
        SELECT
          mh.entry_id, mh.gw, mh.points,
          mh.event_transfers, mh.event_transfers_cost, mh.points_on_bench,
          mp.active_chip,
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

// One FPL fetch per manager visit, gated by `has_transfer_history`. The
// transfer log is append-only on FPL's side so we don't need to refetch
// for managers we've already ingested — but we do refetch when the cron
// processes them again at a new GW (because `processEntry` short-circuits
// via `last_checked_gw === currentGw` long before getting here, this only
// runs when the entry has new GW history to record, which is the same
// cadence at which they could have made new transfers).
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

// Rebuild the (stratum, gw, captain_element, captain_multiplier) aggregate
// table used by getTeamImpact.fetchCaptainRatesInStratum and
// getManagerComparison.sampleMostCaptained. Single TRUNCATE+INSERT inside
// a transaction so readers always see a consistent snapshot — no partial
// state where some captains/GWs are missing.
//
// Exported so backfillStratumCaptainPicks.ts can run the same operation
// out-of-band (e.g. immediately after deploying the schema, before the
// next populate cron tick).
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
// Exported so backfillStratumGwRunningStats.ts can run the same operation
// out-of-band (e.g. immediately after applying the schema migration so
// the new read path has a populated table to read from before the next
// 15-minute populate tick).
export const rebuildStratumGwRunningStats = async (): Promise<void> => {
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`TRUNCATE stratum_gw_running_stats`),
    prisma.$executeRawUnsafe(`
      INSERT INTO stratum_gw_running_stats
        (stratum, gw, sample_size,
         sum_cum_points, sum_cum_transfers, sum_cum_hits_cost,
         sum_cum_bench, sum_cum_captain_bonus, sum_gws_played,
         count_with_transfers, count_with_hits, count_with_bench,
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
        COUNT(*) FILTER (WHERE mc.chip_wildcard_h1)::int           AS cum_wildcards_h1,
        COUNT(*) FILTER (WHERE mc.chip_wildcard_h2)::int           AS cum_wildcards_h2,
        COUNT(*) FILTER (WHERE mc.chip_freehit_h1)::int            AS cum_freehits_h1,
        COUNT(*) FILTER (WHERE mc.chip_freehit_h2)::int            AS cum_freehits_h2,
        COUNT(*) FILTER (WHERE mc.chip_bboost_h1)::int             AS cum_bboosts_h1,
        COUNT(*) FILTER (WHERE mc.chip_bboost_h2)::int             AS cum_bboosts_h2,
        NOW()                                                      AS last_rebuilt
      FROM manager_cumulative mc
      GROUP BY mc.stratum, mc.gw
    `),
  ]);
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

    // Refresh the per-(stratum, gw, captain) aggregate table once at the end
    // of the run. This is the same heavy GROUP BY that the read paths in
    // getTeamImpact.fetchCaptainRatesInStratum and
    // getManagerComparison.sampleMostCaptained run today — done here once
    // per cron cycle instead of per request. ~17k bucket rows; ~2–4s on
    // the prod CX23. Skip on no-op cycles.
    //
    // Same pattern for stratum_gw_running_stats — the per-(stratum, gw)
    // aggregate served from sampleStratumAggregates. ~114 rows output;
    // expensive GROUP BY over manager_cumulative happens here, not per
    // request. ~30–60s on prod.
    if (stats.processed > 0 && !governor.shouldAbort) {
      const captainStarted = Date.now();
      try {
        await rebuildStratumCaptainPicks();
        console.info(
          `[populateManagers] stratum_captain_picks_gw rebuilt in ${Math.round((Date.now() - captainStarted) / 1000)}s`,
        );
      } catch (err) {
        // Rebuild failure shouldn't fail the cron — readers fall back to
        // the previous snapshot. Log loudly so it's caught in pm2 tail.
        console.error(
          "[populateManagers] stratum_captain_picks_gw rebuild failed:",
          (err as Error).message,
        );
      }

      const runningStarted = Date.now();
      try {
        await rebuildStratumGwRunningStats();
        console.info(
          `[populateManagers] stratum_gw_running_stats rebuilt in ${Math.round((Date.now() - runningStarted) / 1000)}s`,
        );
      } catch (err) {
        console.error(
          "[populateManagers] stratum_gw_running_stats rebuild failed:",
          (err as Error).message,
        );
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
