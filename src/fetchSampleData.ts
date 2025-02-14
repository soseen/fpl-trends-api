import fs from "fs";
import { getPlayerHistory, getBasicInfo } from "./fetch";
import { getSamplePlayers, readBlacklist } from "./sampling";
import { LAST_GAMEWEEK_FILE, RAW_PLAYERS_SAMPLE_FILE } from "./file.helpers";
import { delay } from "./utils";

const BATCH_SIZE = 32;
const DELAY_MS = 60;
const MAX_RETRIES = 3;

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
    if (fs.existsSync(RAW_PLAYERS_SAMPLE_FILE)) {
      fs.unlinkSync(RAW_PLAYERS_SAMPLE_FILE); // Remove the raw data file
    }
    fs.writeFileSync(LAST_GAMEWEEK_FILE, lastGameweek.toString(), "utf8"); // Save new gameweek
  }

  // Generate sample player IDs
  const blacklist = readBlacklist();
  const sampledPlayerIds = getSamplePlayers(totalPlayers, blacklist, 5000);

  // Load existing raw data (if any)
  const rawData = fs.existsSync(RAW_PLAYERS_SAMPLE_FILE)
    ? JSON.parse(fs.readFileSync(RAW_PLAYERS_SAMPLE_FILE, "utf8"))
    : {};
  const alreadyProcessedIds = new Set(Object.keys(rawData).map(Number));

  // Filter sample IDs to exclude already processed IDs
  const remainingSampleIds = sampledPlayerIds.filter(
    (id) => !alreadyProcessedIds.has(id),
  );
  console.log(
    `Resuming data fetch for ${remainingSampleIds.length} sampled players...`,
  );

  // Process in batches
  for (let i = 0; i < remainingSampleIds.length; i += BATCH_SIZE) {
    const batch = remainingSampleIds.slice(i, i + BATCH_SIZE);
    console.log(
      `Processing batch: ${i + 1} - ${Math.min(i + BATCH_SIZE, remainingSampleIds.length)}`,
    );

    let retries = 0;
    let success = false;

    while (retries < MAX_RETRIES && !success) {
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
        fs.writeFileSync(
          RAW_PLAYERS_SAMPLE_FILE,
          JSON.stringify(rawData, null, 2),
        );
        console.log(
          `Batch ${i + 1} - ${i + BATCH_SIZE + 1} saved to raw data file.`,
        );

        // Batch succeeded, break out of retry loop
        success = true;
      } catch (error) {
        retries++;
        console.error(
          `Error processing batch ${i + 1}. Retry ${retries}/${MAX_RETRIES}. Error: ${(error as Error).message}`,
        );
        if (retries >= MAX_RETRIES) {
          console.error(
            `Batch ${i + 1} failed after ${MAX_RETRIES} retries. Exiting process.`,
          );
          return; // Exit the entire process if retries exceed max limit
        }
        await delay(500 + retries * 2000);
      }
    }

    await delay(DELAY_MS);
  }

  console.log("Raw data fetching completed.");
};
