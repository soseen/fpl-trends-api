import {
  CSV_FILE,
  LAST_GAMEWEEK_FILE,
  RAW_ALL_DATA_FILE,
  readCheckpoint,
  writeCheckpoint,
} from "./file.helpers";
import fs from "fs";
import { GameweekData } from "./types";
import { getPlayerHistory, getBasicInfo } from "./fetch";
import { readBlacklist } from "./sampling";
import { delay } from "./utils";

const BATCH_SIZE = 20;
const DELAY_MS = 50;

export const fetchAllRawData = async () => {
  const { lastGameweek, totalPlayers } = await getBasicInfo();
  console.log(`Total Players: ${totalPlayers}`);
  console.log("LAST GAMEWEEK: ", lastGameweek);

  const lastProcessedGameweek = fs.existsSync(LAST_GAMEWEEK_FILE)
    ? parseInt(fs.readFileSync(LAST_GAMEWEEK_FILE, "utf8"), 10)
    : 0;

  const startFromScratch = lastGameweek !== lastProcessedGameweek;
  if (startFromScratch) {
    console.log("New gameweek detected. Starting from scratch...");
    if (fs.existsSync(CSV_FILE)) {
      fs.unlinkSync(CSV_FILE); // Remove the file if it exists
    }
    writeCheckpoint(0);
  }

  const blacklist = readBlacklist();
  const playerIds: number[] = Array.from(
    { length: totalPlayers },
    (_, i) => i + 1,
  ).filter((id) => !blacklist.has(id));

  const lastProcessedId = readCheckpoint();
  const remainingPlayers = playerIds.filter((id) => id > lastProcessedId);
  const rawData = fs.existsSync(RAW_ALL_DATA_FILE)
    ? JSON.parse(fs.readFileSync(RAW_ALL_DATA_FILE, "utf8"))
    : {};

  console.log(`Resuming from Player ID: ${lastProcessedId + 1}...`);

  for (let i = 0; i < remainingPlayers.length; i += BATCH_SIZE) {
    const batch = remainingPlayers.slice(i, i + BATCH_SIZE);
    const records: GameweekData[] = [];

    try {
      await Promise.all(
        batch.map(async (playerId) => {
          const playerHistory = await getPlayerHistory(playerId);
          const gameweeks = playerHistory?.current;

          if (!playerHistory || !gameweeks) {
            throw new Error(`No data for player ID ${playerId}`);
          }

          rawData[playerId] = playerHistory; // Save fetched data to the raw data object
        }),
      );

      // Save the raw data file after processing each batch
      fs.writeFileSync(RAW_ALL_DATA_FILE, JSON.stringify(rawData, null, 2));
      console.log(
        `Batch ${i + 1} - ${i + BATCH_SIZE + 1} saved to raw data file.`,
      );

      await delay(DELAY_MS);
    } catch (error) {
      console.error(
        "Error occurred while processing batch. Aborting...",
        error,
      );
      process.exit(1); // Exit the script with an error code
    }

    // Update the checkpoint after each batch
    const lastIdInBatch = batch[batch.length - 1];
    writeCheckpoint(lastIdInBatch);
    fs.writeFileSync(LAST_GAMEWEEK_FILE, lastGameweek.toString(), "utf8");

    console.log(BATCH_SIZE);
    console.log(`Processed batch ${i + 1}-${i + BATCH_SIZE}`);
  }

  writeCheckpoint(0);
  console.log("Processing completed.");
};
