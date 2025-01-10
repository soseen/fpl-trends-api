const fs = require("fs");
const { getTotalPlayers, getPlayerHistory } = require("./fetch");
const createCsvWriter = require("csv-writer").createObjectCsvWriter;

const { prepareRows, createHeaders, readCheckpoint, readExistingCsv, CSV_FILE, writeCheckpoint } = require("./csv.helpers");


// Main function to process all players and save to CSV
async function processAllPlayers() {
  const totalPlayers = await getTotalPlayers();
  console.log(`Total Players: ${totalPlayers}`);

  // Read existing CSV data
  const existingData = await readExistingCsv();

  let headersDefined = false;
  let csvWriter = null;
  const batchSize = 100;
  const lastProcessedId = readCheckpoint();
  const allPlayers = Array.from({ length: totalPlayers }, (_, i) => i + 1);
  const remainingPlayers = allPlayers.filter((id) => id > lastProcessedId);

  console.log(`Resuming from Player ID: ${lastProcessedId + 1}`);

  for (let i = 0; i < remainingPlayers.length; i += batchSize) {
    const batch = remainingPlayers.slice(i, i + batchSize);
    const records = [];

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
          csvWriter = createCsvWriter({
            path: CSV_FILE,
            header: headers,
            append: fs.existsSync(CSV_FILE), // Append if the file exists
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

    console.log(`Processed batch ${i + 1}-${i + batchSize}`);
  }

  console.log("Processing completed.");
}

module.exports = { processAllPlayers };
