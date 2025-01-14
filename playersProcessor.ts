import { createHeaders, CSV_FILE, LAST_GAMEWEEK_FILE, prepareRows, readCheckpoint, writeCheckpoint } from "./file.helpers";
import fs from "fs";
import { createObjectCsvWriter } from "csv-writer"
import { CsvWriter } from "csv-writer/src/lib/csv-writer";
import { GameweekData } from "./types";
import { getPlayerHistory, getBasicInfo } from "./fetch";
import { getSamplePlayers, readBlacklist, writeToBlacklist } from "./sampling";

let csvWriter: CsvWriter<GameweekData> | null = null;
const fetchAllPlayers = false; // Toggle to download all players or sample


const BATCH_SIZE = 100;


export const processAllPlayers = async () => {
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
  const playerIds: number[] = fetchAllPlayers
    ? Array.from({ length: totalPlayers }, (_, i) => i + 1).filter((id) => !blacklist.has(id))
    : getSamplePlayers(totalPlayers, blacklist);

    console.log(playerIds);

  let headersDefined = false;
  const batchSize = 100;
  const lastProcessedId = readCheckpoint();
  const remainingPlayers = fetchAllPlayers ? playerIds.filter((id) => id > lastProcessedId) : playerIds;

  console.log(fetchAllPlayers ? `Resuming from Player ID: ${lastProcessedId + 1}...` : "Reading sample data...");

  for (let i = 0; i < remainingPlayers.length; i += batchSize) {
    const batch = remainingPlayers.slice(i, i + batchSize);
    const records: GameweekData[] = [];

    for (const playerId of batch) {
      try {
        const gameweeks = await getPlayerHistory(playerId);

        if (gameweeks === null) {
          throw new Error(`Failed to fetch data for player ID ${playerId}`);
        }

        // Blacklist logic
        const isInactive =
          gameweeks.length >= 6 && gameweeks.slice(-6).every((gw) => gw.event_transfers === 0);
        const isDeleted = gameweeks.some((gw) => gw.overall_rank === 0);

        if (isInactive) {
          writeToBlacklist(playerId, "inactive");
          continue;
        }

        if (isDeleted) {
          writeToBlacklist(playerId, "deleted");
          continue;
        }

        // Dynamically set headers if not already defined
        if (!headersDefined) {
          const headers = createHeaders(gameweeks[0]);
          csvWriter = createObjectCsvWriter({
            path: CSV_FILE,
            header: headers,
            append: fs.existsSync(CSV_FILE),
          });
          headersDefined = true;
        }

        // Prepare rows for the player
        const rows = prepareRows(playerId, gameweeks);
        records.push(...rows);
      } catch (error) {
        console.error(`Error fetching data for player ID ${playerId}:`, (error as Error).message);
        fs.writeFileSync(`error_${playerId}.log`, (error as Error).toString(), "utf8");
        process.exit(1);
      }
    }

    // Write the current batch to the CSV file
    if (csvWriter && records.length > 0) {
      await csvWriter.writeRecords(records);
      console.log(`Batch written to CSV: ${i + 1}-${i + batchSize}`);
    }

    // Update the checkpoint after each batch
    const lastIdInBatch = batch[batch.length - 1];
    writeCheckpoint(lastIdInBatch);
    fs.writeFileSync(LAST_GAMEWEEK_FILE, lastGameweek.toString(), "utf8");

    console.log(`Processed batch ${i + 1}-${i + batchSize}`);
  }

  if (fetchAllPlayers) {
    writeCheckpoint(0);
  }

  console.log("Processing completed.");
};


module.exports = { processAllPlayers };




