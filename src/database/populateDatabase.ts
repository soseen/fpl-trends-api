import "dotenv/config";
import fs from "fs";
import { fileURLToPath } from "node:url";
import { insertFootballersFixtures } from "./insertFootballersFixtures.js";
import { insertFootballers } from "./insertFootballers.js";
import { insertTeams } from "./insertTeams.js";
import { insertFootballersHistory } from "./insertFootballersHistory.js";
import { fetchBootstrapStatic } from "../bootstrapStatic/fetchBootstrapStatic.js";
import { fetchFootballers } from "../footballers/fetchFootballers.js";
import { insertEvents } from "../events/insertEvents.js";
import { insertTeamHistory } from "./insertTeamHistory.js";
import {
  RAW_BOOTSTRAP_STATIC_FILE,
  RAW_FOOTBALLERS_FILE,
} from "../file.helpers.js";
import {
  detectSeasonChange,
  evaluateSeasonClosure,
  markSeasonClosureJobComplete,
  performSeasonReset,
} from "./seasonManager.js";
import { prisma } from "./client.js";
import { getFixturesData } from "../fetch.js";
import type { BootstrapStaticData } from "../bootstrapStatic/types.js";
import type { Footballer } from "../footballers/types.js";
import { syncPenaltyFeed } from "../penalties/syncPenaltyFeed.js";
import {
  getDeepCoveredSeasons,
  getPlayerSeasonPenaltyTotals,
} from "../penalties/ledger.js";
import { enrichHistoryPast } from "../nonPenalty/historyPast.js";

const DATA_REFRESH_VERSION_KEY = "bulk_data_refresh_version";

const markBulkDataRefreshComplete = async (): Promise<void> => {
  const value = new Date().toISOString();
  await prisma.$executeRaw`
    INSERT INTO app_metadata (key, value)
    VALUES (${DATA_REFRESH_VERSION_KEY}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
};

const latestPublishableEventId = (events: BootstrapStaticData["events"]) =>
  Math.max(
    0,
    ...events
      .filter((event) => event.finished || event.is_current)
      .map((event) => event.id),
  );

const latestFootballerHistoryRound = (
  footballers: Record<string, Footballer>,
) => {
  let latestRound = 0;
  for (const footballer of Object.values(footballers)) {
    for (const history of footballer.history ?? []) {
      latestRound = Math.max(latestRound, history.round);
    }
  }
  return latestRound;
};

const assertBulkPublicationFresh = async ({
  expectedEventId,
  expectedHistoryRound,
}: {
  expectedEventId: number;
  expectedHistoryRound: number;
}): Promise<void> => {
  const [eventSummary] = await prisma.$queryRaw<
    Array<{ latest_event_id: number | null }>
  >`
    SELECT MAX(id) AS latest_event_id
    FROM events
  `;
  const [historySummary] = await prisma.$queryRaw<
    Array<{ latest_round: number | null }>
  >`
    SELECT MAX(round) AS latest_round
    FROM history
  `;

  const latestEventId = eventSummary?.latest_event_id ?? 0;
  const latestHistoryRound = historySummary?.latest_round ?? 0;

  if (expectedEventId > 0 && latestEventId < expectedEventId) {
    throw new Error(
      `[populateDatabase] Publication incomplete: events table is at GW${latestEventId}, expected at least GW${expectedEventId}.`,
    );
  }
  if (expectedHistoryRound > 0 && latestHistoryRound < expectedHistoryRound) {
    throw new Error(
      `[populateDatabase] Publication incomplete: history table is at GW${latestHistoryRound}, expected at least GW${expectedHistoryRound}.`,
    );
  }
  if (latestHistoryRound > latestEventId) {
    throw new Error(
      `[populateDatabase] Publication inconsistent: history is at GW${latestHistoryRound}, but events are only at GW${latestEventId}.`,
    );
  }

  console.info(
    `[populateDatabase] Publication freshness verified: events through GW${latestEventId}, history through GW${latestHistoryRound}.`,
  );
};

export const populateDatabase = async () => {
  try {
    // 1. Fetch bootstrap data first (needed for season detection)
    console.info("Fetching Bootstrap Static...");
    await fetchBootstrapStatic();

    // 2. Season detection: read events from the freshly fetched bootstrap data
    const bootstrapRaw = fs.readFileSync(RAW_BOOTSTRAP_STATIC_FILE, "utf-8");
    const bootstrapData = JSON.parse(bootstrapRaw) as {
      events: Array<{
        id?: number;
        finished?: boolean;
        data_checked?: boolean;
        deadline_time?: string;
        deadline_time_epoch?: number;
      }>;
    };

    const seasonCheck = await detectSeasonChange(bootstrapData.events);

    if (seasonCheck.isNewSeason) {
      console.info(
        `🔄 Season changed: ${seasonCheck.oldSeason ?? "none"} → ${seasonCheck.newSeason}`,
      );
      await performSeasonReset(seasonCheck.newSeason, seasonCheck.oldSeason);

      // Re-fetch bootstrap since we deleted the file during wipe
      console.info("Re-fetching Bootstrap Static after season reset...");
      await fetchBootstrapStatic();
    } else {
      console.info(`📋 Current season: ${seasonCheck.currentSeason}`);
    }

    const closureDecision = await evaluateSeasonClosure(
      bootstrapData.events,
      "bulk-data",
    );
    if (!closureDecision.shouldRun) {
      console.info(
        `[populateDatabase] Season refresh skipped: ${closureDecision.reason}.`,
      );
      return;
    }
    console.info(
      `[populateDatabase] Season refresh allowed: ${closureDecision.reason}.`,
    );

    // 3. Fetch individual footballer data
    console.info("Fetching footballers...");
    await fetchFootballers();

    // Validate the complete official penalty mapping before publishing any
    // new game rows. A feed or mapping error deliberately fails this run.
    const currentBootstrap = JSON.parse(
      fs.readFileSync(RAW_BOOTSTRAP_STATIC_FILE, "utf-8"),
    ) as BootstrapStaticData;
    const footballers = JSON.parse(
      fs.readFileSync(RAW_FOOTBALLERS_FILE, "utf-8"),
    ) as Record<string, Footballer>;
    const fplFixtures = await getFixturesData();
    const currentSeason = seasonCheck.isNewSeason
      ? seasonCheck.newSeason
      : seasonCheck.currentSeason;
    if (currentSeason === "unknown") {
      throw new Error("Cannot publish without a valid FPL season identifier.");
    }
    console.info("Reconciling official penalty events...");
    await syncPenaltyFeed({
      season: currentSeason,
      bootstrap: currentBootstrap,
      footballers,
      fplFixtures,
      finalSeason: currentBootstrap.events.every(
        (event) => event.finished && event.data_checked,
      ),
    });
    const [penaltyTotals, deepCoveredSeasons] = await Promise.all([
      getPlayerSeasonPenaltyTotals(),
      getDeepCoveredSeasons(),
    ]);
    for (const player of currentBootstrap.elements) {
      for (const historyPast of footballers[String(player.id)]?.history_past ??
        []) {
        enrichHistoryPast(
          historyPast,
          player.code,
          penaltyTotals,
          deepCoveredSeasons,
        );
      }
    }

    // 4. Populate database tables (order matters: teams → events → footballers → fixtures → history)
    console.info("Populating teams...");
    await insertTeams();

    console.info("Populating events...");
    await insertEvents();

    console.info("Populating footballers...");
    await insertFootballers();

    console.info("Populating fixtures...");
    await insertFootballersFixtures();

    console.info("Populating team history...");
    await insertTeamHistory(currentSeason, fplFixtures);

    console.info("Populating footballers history...");
    await insertFootballersHistory(currentSeason, fplFixtures);

    await assertBulkPublicationFresh({
      expectedEventId: latestPublishableEventId(currentBootstrap.events),
      expectedHistoryRound: latestFootballerHistoryRound(footballers),
    });

    await markBulkDataRefreshComplete();

    if (closureDecision.shouldCloseAfterRun && closureDecision.season) {
      await markSeasonClosureJobComplete("bulk-data", closureDecision.season);
      console.info(
        `[populateDatabase] Final bulk refresh complete for ${closureDecision.season}; future runs will skip until a new season is detected.`,
      );
    }

    console.info("✅ Database populated successfully!");
  } catch (error) {
    console.error("❌ Failed to populate the database:", error);
    process.exit(1);
  }
};

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await populateDatabase();
  } finally {
    await prisma.$disconnect();
  }
}
