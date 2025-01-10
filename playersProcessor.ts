import { createHeaders, CSV_FILE, LAST_GAMEWEEK_FILE, prepareRows, readCheckpoint, readExistingCsv, writeCheckpoint } from "./csv.helpers";
import fs from "fs";
import { createObjectCsvWriter } from "csv-writer"
import { CsvWriter } from "csv-writer/src/lib/csv-writer";
import { GameweekData } from "./types";
import { getPlayerHistory, getBasicInfo } from "./fetch";

let csvWriter: CsvWriter<GameweekData> | null = null;


// Main function to process all players and save to CSV
export const processAllPlayers = async () => {
  const {lastGameweek, totalPlayers} = await getBasicInfo();
  console.log(`Total Players: ${totalPlayers}`);
  console.log ("LAST GAMEWEEK: ", lastGameweek);

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

  // Read existing CSV data
  const existingData = await readExistingCsv();

  let headersDefined = false;
  const batchSize = 100;
  const lastProcessedId = readCheckpoint();
  const allPlayers = Array.from({ length: totalPlayers }, (_, i) => i + 1);
  const remainingPlayers = allPlayers.filter((id) => id > lastProcessedId)

  console.log(`Resuming from Player ID: ${lastProcessedId + 1}`);

  for (let i = 0; i < remainingPlayers.length; i += batchSize) {
    const batch = remainingPlayers.slice(i, i + batchSize);
    const records: GameweekData[] = [];

    const shouldStop = await Promise.all(
      batch.map(async (playerId) => {
        const gameweeks = await getPlayerHistory(playerId);

        if (gameweeks === null) {
          return false; // Skip players whose API call fails
        }

        if (gameweeks.length === 0) {
          console.log(`Player ${playerId} has no gameweek history. Stopping the process.`);
          return true; // Stop if the player has no history
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

        // Check if this player's data needs to be updated
        const existingPlayerData = existingData[playerId];
        if (existingPlayerData) {
          // Check if gameweek data has changed (e.g., new gameweek added)
          const existingGameweeks = new Set(existingPlayerData.map((r) => r.event));
          const newGameweeks = new Set(rows.map((r) => r.event));

          // If there's no difference, skip updating this player
          if ([...existingGameweeks].every((gw) => newGameweeks.has(gw))) {
            return false;
          }
        }

        // Add rows to the records (new or updated)
        records.push(...rows);

        return false;
      })

    );

    // Check if we need to stop processing further players
    if (shouldStop.includes(true)) {
      console.log("Encountered a player with no history. Stopping further processing.");
      break;
    }

    // Write the current batch to the CSV file
    if (csvWriter && records.length > 0) {
      // Remove outdated data for players in this batch
      const updatedPlayers = new Set(records.map((r) => r.Player_ID));
      const updatedData = Object.values(existingData)
        .flat()
        .filter((row) => !updatedPlayers.has(row.Player_ID));

      // Add the new data
      updatedData.push(...records);

      // Write all updated data back to the CSV
      await csvWriter.writeRecords(updatedData);
      console.log(`Batch written to CSV: ${i + 1}-${i + batchSize}`);
    }

    // Update the checkpoint after each batch
    const lastIdInBatch = batch[batch.length - 1];
    writeCheckpoint(lastIdInBatch);
    fs.writeFileSync(LAST_GAMEWEEK_FILE, lastGameweek.toString(), "utf8");

    console.log(`Processed batch ${i + 1}-${i + batchSize}`);
  }

  writeCheckpoint(0);
  console.log("Processing completed.");
}

module.exports = { processAllPlayers };
