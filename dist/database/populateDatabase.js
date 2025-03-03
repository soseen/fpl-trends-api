import { insertFootballersFixtures } from "./insertFootballersFixtures";
import { insertFootballers } from "./insertFootballers";
import { insertTeams } from "./insertTeams";
import { insertFootballersHistory } from "./insertFootballersHistory";
import { fetchBootstrapStatic } from "../bootstrapStatic/fetchBootstrapStatic";
import { fetchFootballers } from "../footballers/fetchFootballers";
import { insertEvents } from "../events/insertEvents";
(async () => {
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
        console.log("Starting to populate history...");
        await insertFootballersHistory();
        console.log("Database populated successfully!");
    }
    catch (error) {
        console.error("Failed to populate the database:", error);
        return false;
    }
})();
