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
import { RAW_BOOTSTRAP_STATIC_FILE } from "../file.helpers.js";
import {
  detectSeasonChange,
  evaluateSeasonClosure,
  markSeasonClosureJobComplete,
  performSeasonReset,
} from "./seasonManager.js";
import { prisma } from "./client.js";

const DATA_REFRESH_VERSION_KEY = "bulk_data_refresh_version";

const markBulkDataRefreshComplete = async (): Promise<void> => {
  const value = new Date().toISOString();
  await prisma.$executeRaw`
    INSERT INTO app_metadata (key, value)
    VALUES (${DATA_REFRESH_VERSION_KEY}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
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
      await performSeasonReset(seasonCheck.newSeason);

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
    await insertTeamHistory();

    console.info("Populating footballers history...");
    await insertFootballersHistory();

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
