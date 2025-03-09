import { insertFootballersFixtures } from "./insertFootballersFixtures.js";
import { insertFootballers } from "./insertFootballers.js";
import { insertTeams } from "./insertTeams.js";
import { insertFootballersHistory } from "./insertFootballersHistory.js";
import { fetchBootstrapStatic } from "../bootstrapStatic/fetchBootstrapStatic.js";
import { fetchFootballers } from "../footballers/fetchFootballers.js";
import { insertEvents } from "../events/insertEvents.js";
import { insertTeamHistory } from "./insertTeamHistory.js";

export const populateDatabase = async () => {
  try {
    console.log("Fetching Bootstrap Static...");
    await fetchBootstrapStatic();
    console.log("Fetching footballers...");
    await fetchFootballers();
    console.log("Starting to populate teams...");
    await insertTeams();
    console.log("Starting to populate events...");
    await insertEvents();
    console.log("Starting to populate footballers...");
    await insertFootballers();
    console.log("Starting to populate fixtures...");
    await insertFootballersFixtures();
    console.log("Starting to populate team history...");
    await insertTeamHistory();
    console.log("Starting to populate history...");
    await insertFootballersHistory();
    console.log("✅ Database populated successfully!");
  } catch (error) {
    console.error("❌ Failed to populate the database:", error);
    process.exit(1);
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  populateDatabase()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
