import fs from "fs";
import { insertFootballersFixtures } from "./insertFootballersFixtures.js";
import { insertFootballers } from "./insertFootballers.js";
import { insertTeams } from "./insertTeams.js";
import { insertFootballersHistory } from "./insertFootballersHistory.js";
import { fetchBootstrapStatic } from "../bootstrapStatic/fetchBootstrapStatic.js";
import { fetchFootballers } from "../footballers/fetchFootballers.js";
import { insertEvents } from "../events/insertEvents.js";
import { insertTeamHistory } from "./insertTeamHistory.js";
import { RAW_BOOTSTRAP_STATIC_FILE } from "../file.helpers.js";
import { detectSeasonChange, performSeasonReset } from "./seasonManager.js";

export const populateDatabase = async () => {
  try {
    // 1. Fetch bootstrap data first (needed for season detection)
    console.info("Fetching Bootstrap Static...");
    await fetchBootstrapStatic();

    // 2. Season detection: read events from the freshly fetched bootstrap data
    const bootstrapRaw = fs.readFileSync(RAW_BOOTSTRAP_STATIC_FILE, "utf-8");
    const bootstrapData = JSON.parse(bootstrapRaw) as {
      events: Array<{ deadline_time?: string; deadline_time_epoch?: number }>;
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

    console.info("✅ Database populated successfully!");
  } catch (error) {
    console.error("❌ Failed to populate the database:", error);
    process.exit(1);
  }
};

if (process.argv[1] && process.argv[1].endsWith("populateDatabase.ts")) {
  await populateDatabase();
}
