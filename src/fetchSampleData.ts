import fs from "fs";
import { getPlayerHistory, getBasicInfo } from "./fetch";
import { getSamplePlayers, readBlacklist } from "./sampling";
import { LAST_GAMEWEEK_FILE, RAW_DATA_FILE } from "./file.helpers";
import { delay } from "./utils";

const BATCH_SIZE = 32;
const DELAY_MS = 60;

export const fetchSampleData = async () => {
  const { lastGameweek, totalPlayers } = await getBasicInfo();
  console.log(`Total Players: ${totalPlayers}`);
  console.log("LAST GAMEWEEK: ", lastGameweek);

  // Check if we need to start from scratch
  const lastProcessedGameweek = fs.existsSync(LAST_GAMEWEEK_FILE)
    ? parseInt(fs.readFileSync(LAST_GAMEWEEK_FILE, "utf8"), 10)
    : 0;

  const startFromScratch = lastGameweek !== lastProcessedGameweek;
  if (startFromScratch) {
    console.log("New gameweek detected. Starting from scratch...");
    if (fs.existsSync(RAW_DATA_FILE)) {
      fs.unlinkSync(RAW_DATA_FILE); // Remove the raw data file
    }
    fs.writeFileSync(LAST_GAMEWEEK_FILE, lastGameweek.toString(), "utf8"); // Save new gameweek
  }

  // Generate sample player IDs
  const blacklist = readBlacklist();
  const sampledPlayerIds = getSamplePlayers(totalPlayers, blacklist);

  // Load existing raw data (if any)
  const rawData = fs.existsSync(RAW_DATA_FILE)
    ? JSON.parse(fs.readFileSync(RAW_DATA_FILE, "utf8"))
    : {};
  const alreadyProcessedIds = new Set(Object.keys(rawData).map(Number));

  // Filter sample IDs to exclude already processed IDs
  const remainingSampleIds = sampledPlayerIds.filter(
    (id) => !alreadyProcessedIds.has(id),
  );
  console.log(`Data fetch for ${remainingSampleIds.length} sampled players...`);

  // Process in batches
  for (let i = 0; i < remainingSampleIds.length; i += BATCH_SIZE) {
    const batch = remainingSampleIds.slice(i, i + BATCH_SIZE);
    console.log(
      `Processing batch: ${i + 1} - ${Math.min(i + BATCH_SIZE, remainingSampleIds.length)}`,
    );

    try {
      await Promise.all(
        batch.map(async (playerId) => {
          const playerHistory = await getPlayerHistory(playerId);
          const gameweeks = playerHistory?.current;

          if (!playerHistory) {
            throw new Error(`No data for player ID ${playerId}`);
          }

          if (!gameweeks) {
            return;
          }

          rawData[playerId] = playerHistory; // Save fetched data to the raw data object
        }),
      );

      // Save the raw data file after processing each batch
      fs.writeFileSync(RAW_DATA_FILE, JSON.stringify(rawData, null, 2));
      console.log(
        `Batch ${i + 1} - ${i + BATCH_SIZE + 1} saved to raw data file.`,
      );

      // Apply a delay after each batch
      console.log("Applying delay...");
      await delay(DELAY_MS);
    } catch (error) {
      console.error(
        "Error occurred while processing batch. Aborting...",
        error,
      );
      process.exit(1); // Exit the script with an error code
    }
  }

  console.log("Raw data fetching completed.");
};
