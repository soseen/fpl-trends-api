import fs from "fs";
import { Prisma } from "@prisma/client";
import { prisma } from "./client.js";
import {
  RAW_BOOTSTRAP_STATIC_FILE,
  RAW_FOOTBALLERS_FILE,
} from "../file.helpers.js";

const SEASON_KEY = "current_season";
const SEASON_END_OBSERVED_AT_KEY = "season_end_observed_at";
const SEASON_END_SEASON_KEY = "season_end_season";
const SEASON_END_EVENT_ID_KEY = "season_end_event_id";
const SEASON_END_BULK_CLOSED_KEY = "season_end_bulk_closed_for_season";
const SEASON_END_MANAGER_CLOSED_KEY =
  "season_end_manager_ingest_closed_for_season";
const DEFAULT_SEASON_END_GRACE_DAYS = 5;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type SeasonClosureJob = "bulk-data" | "manager-ingest";

export type SeasonClosureDecision =
  | {
      shouldRun: false;
      shouldCloseAfterRun: false;
      season: string;
      finalEventId: number;
      reason: string;
    }
  | {
      shouldRun: true;
      shouldCloseAfterRun: boolean;
      season: string | null;
      finalEventId: number | null;
      reason: string;
    };

type SeasonClosureEvent = {
  id?: number;
  finished?: boolean;
  data_checked?: boolean;
  deadline_time?: string;
  deadline_time_epoch?: number;
};

const jobClosedKey = (job: SeasonClosureJob): string =>
  job === "bulk-data"
    ? SEASON_END_BULK_CLOSED_KEY
    : SEASON_END_MANAGER_CLOSED_KEY;

const getMetadataValue = async (key: string): Promise<string | null> => {
  try {
    const rows = await prisma.$queryRaw<Array<{ value: string }>>`
      SELECT value FROM app_metadata WHERE key = ${key}
    `;
    return rows[0]?.value ?? null;
  } catch {
    return null;
  }
};

const setMetadataValue = async (key: string, value: string): Promise<void> => {
  await prisma.$executeRaw`
    INSERT INTO app_metadata (key, value)
    VALUES (${key}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
};

const deleteMetadataKeys = async (keys: string[]): Promise<void> => {
  await prisma.$executeRaw`
    DELETE FROM app_metadata WHERE key IN (${Prisma.join(keys)})
  `;
};

const readSeasonEndGraceDays = (): number => {
  const raw = process.env["SEASON_END_GRACE_DAYS"];
  if (!raw) return DEFAULT_SEASON_END_GRACE_DAYS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_SEASON_END_GRACE_DAYS;
  }

  return parsed;
};

const latestEvent = (
  events: SeasonClosureEvent[],
): SeasonClosureEvent | null => {
  const withIds = events.filter((event) => Number.isInteger(event.id));
  if (withIds.length === 0) return null;

  return withIds.reduce((latest, event) =>
    (event.id ?? 0) > (latest.id ?? 0) ? event : latest,
  );
};

const eventDeadlineDate = (event: SeasonClosureEvent): Date | null => {
  if (event.deadline_time) {
    const parsed = new Date(event.deadline_time);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  if (event.deadline_time_epoch) {
    const parsed = new Date(event.deadline_time_epoch * 1000);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return null;
};

/**
 * Derives the FPL season identifier from the first event's deadline.
 *
 * The FPL season spans two calendar years (e.g. Aug 2025 → May 2026).
 * We use the deadline of the first gameweek to determine the start year,
 * then format as "YYYY-YY" (e.g. "2025-26").
 *
 * If no events exist or parsing fails, returns null.
 */
export function deriveSeasonFromEvents(
  events: Array<{ deadline_time?: string; deadline_time_epoch?: number }>,
): string | null {
  if (!events || events.length === 0) return null;

  const firstEvent = events[0];
  if (!firstEvent) return null;

  let startYear: number | null = null;

  // Try deadline_time string first (e.g. "2025-08-16T10:00:00Z")
  if (firstEvent.deadline_time) {
    const parsed = new Date(firstEvent.deadline_time);
    if (!isNaN(parsed.getTime())) {
      startYear = parsed.getFullYear();
    }
  }

  // Fallback to epoch
  if (startYear === null && firstEvent.deadline_time_epoch) {
    const parsed = new Date(firstEvent.deadline_time_epoch * 1000);
    if (!isNaN(parsed.getTime())) {
      startYear = parsed.getFullYear();
    }
  }

  if (startYear === null) return null;

  const endYearShort = String((startYear + 1) % 100).padStart(2, "0");
  return `${startYear}-${endYearShort}`;
}

export async function clearSeasonClosureState(): Promise<void> {
  await deleteMetadataKeys([
    SEASON_END_OBSERVED_AT_KEY,
    SEASON_END_SEASON_KEY,
    SEASON_END_EVENT_ID_KEY,
    SEASON_END_BULK_CLOSED_KEY,
    SEASON_END_MANAGER_CLOSED_KEY,
  ]);
}

export async function evaluateSeasonClosure(
  events: SeasonClosureEvent[],
  job: SeasonClosureJob,
  now = new Date(),
): Promise<SeasonClosureDecision> {
  const season = deriveSeasonFromEvents(events);
  if (!season) {
    return {
      shouldRun: true,
      shouldCloseAfterRun: false,
      season: null,
      finalEventId: null,
      reason: "season could not be derived",
    };
  }

  const finalEvent = latestEvent(events);
  if (!finalEvent?.id) {
    return {
      shouldRun: true,
      shouldCloseAfterRun: false,
      season,
      finalEventId: null,
      reason: "no final event found",
    };
  }

  const finalEventChecked = Boolean(
    finalEvent.finished && finalEvent.data_checked,
  );
  if (!finalEventChecked) {
    return {
      shouldRun: true,
      shouldCloseAfterRun: false,
      season,
      finalEventId: finalEvent.id,
      reason: `final event ${finalEvent.id} is not checked yet`,
    };
  }

  const closedSeason = await getMetadataValue(jobClosedKey(job));
  if (closedSeason === season) {
    return {
      shouldRun: false,
      shouldCloseAfterRun: false,
      season,
      finalEventId: finalEvent.id,
      reason: `${job} already completed its final ${season} run`,
    };
  }

  const observedSeason = await getMetadataValue(SEASON_END_SEASON_KEY);
  const observedEventId = await getMetadataValue(SEASON_END_EVENT_ID_KEY);
  const observedAtRaw = await getMetadataValue(SEASON_END_OBSERVED_AT_KEY);
  let observedAt = observedAtRaw ? new Date(observedAtRaw) : null;

  if (
    observedSeason !== season ||
    observedEventId !== String(finalEvent.id) ||
    !observedAt ||
    Number.isNaN(observedAt.getTime())
  ) {
    const finalDeadline = eventDeadlineDate(finalEvent);
    observedAt =
      finalDeadline && finalDeadline.getTime() < now.getTime()
        ? finalDeadline
        : now;
    await Promise.all([
      setMetadataValue(SEASON_END_SEASON_KEY, season),
      setMetadataValue(SEASON_END_EVENT_ID_KEY, String(finalEvent.id)),
      setMetadataValue(SEASON_END_OBSERVED_AT_KEY, observedAt.toISOString()),
    ]);
  }

  const graceDays = readSeasonEndGraceDays();
  const graceEndsAt = new Date(observedAt.getTime() + graceDays * MS_PER_DAY);
  const shouldCloseAfterRun = now.getTime() >= graceEndsAt.getTime();

  return {
    shouldRun: true,
    shouldCloseAfterRun,
    season,
    finalEventId: finalEvent.id,
    reason: shouldCloseAfterRun
      ? `${graceDays}-day season-end grace period elapsed`
      : `within ${graceDays}-day season-end grace period until ${graceEndsAt.toISOString()}`,
  };
}

export async function evaluateObservedSeasonClosure(
  job: SeasonClosureJob,
  now = new Date(),
): Promise<SeasonClosureDecision> {
  const season = await getMetadataValue(SEASON_END_SEASON_KEY);
  const finalEventIdRaw = await getMetadataValue(SEASON_END_EVENT_ID_KEY);
  const observedAtRaw = await getMetadataValue(SEASON_END_OBSERVED_AT_KEY);
  const finalEventId = finalEventIdRaw ? Number(finalEventIdRaw) : NaN;
  const observedAt = observedAtRaw ? new Date(observedAtRaw) : null;

  if (
    !season ||
    !Number.isInteger(finalEventId) ||
    !observedAt ||
    Number.isNaN(observedAt.getTime())
  ) {
    return {
      shouldRun: true,
      shouldCloseAfterRun: false,
      season: null,
      finalEventId: null,
      reason: "season end has not been observed from bootstrap data",
    };
  }

  const closedSeason = await getMetadataValue(jobClosedKey(job));
  if (closedSeason === season) {
    return {
      shouldRun: false,
      shouldCloseAfterRun: false,
      season,
      finalEventId,
      reason: `${job} already completed its final ${season} run`,
    };
  }

  const graceDays = readSeasonEndGraceDays();
  const graceEndsAt = new Date(observedAt.getTime() + graceDays * MS_PER_DAY);
  const shouldCloseAfterRun = now.getTime() >= graceEndsAt.getTime();

  return {
    shouldRun: true,
    shouldCloseAfterRun,
    season,
    finalEventId,
    reason: shouldCloseAfterRun
      ? `${graceDays}-day season-end grace period elapsed`
      : `within ${graceDays}-day season-end grace period until ${graceEndsAt.toISOString()}`,
  };
}

export async function markSeasonClosureJobComplete(
  job: SeasonClosureJob,
  season: string,
): Promise<void> {
  await setMetadataValue(jobClosedKey(job), season);
}

/**
 * Reads the stored season identifier from the database.
 * Returns null if no season has been recorded yet.
 */
export async function getStoredSeason(): Promise<string | null> {
  try {
    const rows = await prisma.$queryRaw<Array<{ value: string }>>`
      SELECT value FROM app_metadata WHERE key = ${SEASON_KEY}
    `;
    return rows[0]?.value ?? null;
  } catch {
    // Table might not exist yet (pre-migration)
    return null;
  }
}

/**
 * Stores the current season identifier in the database.
 */
export async function storeCurrentSeason(season: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO app_metadata (key, value)
    VALUES (${SEASON_KEY}, ${season})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
}

/**
 * Checks whether a new season has started by comparing the API's season
 * against what's stored in the database.
 *
 * Returns:
 *  - { isNewSeason: true, newSeason, oldSeason } if a reset is needed
 *  - { isNewSeason: false, currentSeason } if we're within the same season
 */
export async function detectSeasonChange(
  events: Array<{ deadline_time?: string; deadline_time_epoch?: number }>,
): Promise<
  | { isNewSeason: true; newSeason: string; oldSeason: string | null }
  | { isNewSeason: false; currentSeason: string }
> {
  const newSeason = deriveSeasonFromEvents(events);

  if (!newSeason) {
    console.warn(
      "⚠️  Could not derive season from FPL API events. Skipping season check.",
    );
    return { isNewSeason: false, currentSeason: "unknown" };
  }

  const storedSeason = await getStoredSeason();

  if (storedSeason === null) {
    // First run with season tracking. Existing rows in other tables predate
    // this mechanism and may be from an older season — we can't verify, so
    // treat this as a season change whenever game data is already present.
    const existingTeams = await prisma.teams.count();
    const existingFootballers = await prisma.footballers.count();
    const existingEvents = await prisma.events.count();
    const hasExistingData =
      existingTeams > 0 || existingFootballers > 0 || existingEvents > 0;

    if (hasExistingData) {
      console.info(
        `📋 Season tracking initialized on a populated DB — wiping potentially stale data before adopting ${newSeason}.`,
      );
      return { isNewSeason: true, newSeason, oldSeason: null };
    }

    console.info(`📋 First run detected. Recording season as ${newSeason}.`);
    await storeCurrentSeason(newSeason);
    return { isNewSeason: false, currentSeason: newSeason };
  }

  if (storedSeason !== newSeason) {
    return { isNewSeason: true, newSeason, oldSeason: storedSeason };
  }

  return { isNewSeason: false, currentSeason: storedSeason };
}

/**
 * Performs a full database wipe of all game data tables.
 * Order matters due to foreign key constraints:
 *   1. footballer_fixtures (FK → footballers)
 *   2. history (FK → footballers)
 *   3. team_history (FK → teams)
 *   4. events (no FK)
 *   5. footballers (FK → teams)
 *   6. teams (no FK)
 *
 * Also deletes cached JSON data files.
 */
export async function wipeAllSeasonData(): Promise<void> {
  console.info("🗑️  Wiping all season data from the database...");

  // Delete in order of dependencies (children first)
  await prisma.footballer_fixtures.deleteMany();
  console.info("   ✓ footballer_fixtures cleared");

  await prisma.history.deleteMany();
  console.info("   ✓ history cleared");

  await prisma.team_history.deleteMany();
  console.info("   ✓ team_history cleared");

  await prisma.events.deleteMany();
  console.info("   ✓ events cleared");

  await prisma.footballers.deleteMany();
  console.info("   ✓ footballers cleared");

  await prisma.teams.deleteMany();
  console.info("   ✓ teams cleared");

  // Manager-rank tables are season-scoped — points only make sense within
  // the season they were earned. Wipe them on season change.
  // Order: cumulative + history (children of summary) → summary. Cascade
  // would handle this via the FK, but explicit deletes keep the wipe log
  // auditable.
  await prisma.manager_cumulative.deleteMany();
  console.info("   ✓ manager_cumulative cleared");

  await prisma.manager_history.deleteMany();
  console.info("   ✓ manager_history cleared");

  await prisma.manager_summary.deleteMany();
  console.info("   ✓ manager_summary cleared");

  // stratum_captain_picks_gw is denormalised aggregate state, not FK-linked
  // to manager_summary, so it doesn't cascade. Truncate it explicitly so a
  // new-season populate doesn't read stale buckets from the previous one.
  // Raw SQL (rather than `prisma.stratum_captain_picks_gw.deleteMany()`)
  // because the generated Prisma client may not yet include the new model
  // on hosts where `prisma generate` couldn't run (Windows dev DLL lock,
  // or first-deploy ordering issues). Same pattern getTeamImpact uses for
  // `manager_pick_elements`.
  await prisma.$executeRawUnsafe(`TRUNCATE stratum_captain_picks_gw`);
  await prisma.$executeRawUnsafe(`TRUNCATE rank_band_player_exposure_gw`);
  console.info("   rank_band_player_exposure_gw cleared");
  console.info("   ✓ stratum_captain_picks_gw cleared");

  await clearSeasonClosureState();
  console.info("   season closure state cleared");

  // Delete cached data files
  const filesToDelete = [RAW_BOOTSTRAP_STATIC_FILE, RAW_FOOTBALLERS_FILE];

  for (const filePath of filesToDelete) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.info(`   ✓ Deleted ${filePath}`);
    }
  }

  console.info("✅ All season data wiped successfully.");
}

/**
 * Full season reset: wipe data, then store the new season identifier.
 */
export async function performSeasonReset(newSeason: string): Promise<void> {
  console.info(
    `\n🔄 SEASON CHANGE DETECTED — performing full data reset for ${newSeason}...\n`,
  );
  await wipeAllSeasonData();
  await storeCurrentSeason(newSeason);
  console.info(`📋 Season updated to ${newSeason}.\n`);
}
