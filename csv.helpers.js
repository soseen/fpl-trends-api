const fs = require("fs");
const csv = require("csv-parser");

const CHECKPOINT_FILE = "checkpoint.txt";
const CSV_FILE = "fpl_players_gameweek_data.csv";

// Read the last checkpoint (last processed player ID)
const readCheckpoint = () => {
  if (fs.existsSync(CHECKPOINT_FILE)) {
    const lastProcessed = fs.readFileSync(CHECKPOINT_FILE, "utf8");
    return parseInt(lastProcessed, 10) || 0;
  }
  return 0;
};
  
// Write the checkpoint (last processed player ID)
const writeCheckpoint = (playerId) => {
  fs.writeFileSync(CHECKPOINT_FILE, playerId.toString(), "utf8");
};

// Dynamically create headers from the API response
const createHeaders = (sampleGameweek) =>  {
  const headers = [{ id: "Player_ID", title: "Player_ID" }];
  Object.keys(sampleGameweek).forEach((key) => {
    headers.push({ id: key, title: key });
  }); 
  return headers;
};

// Prepare rows dynamically based on the API response
const prepareRows = (playerId, gameweeks) => gameweeks.map((gameweek) => ({
  Player_ID: playerId,
  ...gameweek, // Spread all keys from the gameweek JSON into the row
}));


// Read existing data from the CSV file
const readExistingCsv = () => 
  new Promise((resolve, reject) => {
    const data = {};
    if (!fs.existsSync(CSV_FILE)) {
      return resolve(data); // Return empty if file doesn't exist
    }

    fs.createReadStream(CSV_FILE)
      .pipe(csv())
      .on("data", (row) => {
        const playerId = row.Player_ID;
        if (!data[playerId]) data[playerId] = [];
        data[playerId].push(row);
      })
      .on("end", () => resolve(data))
      .on("error", (error) => reject(error));
  });

  

module.exports = {readCheckpoint, writeCheckpoint, createHeaders, prepareRows, readExistingCsv, CSV_FILE};