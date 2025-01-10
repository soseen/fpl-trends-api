import fs from "fs";
import csv from "csv-parser";
import path from "path";
import { GameweekData } from "./types";

const FILES_FOLDER = path.join(__dirname, "files");
export const CSV_FILE = path.join(FILES_FOLDER, "fpl_players_gameweek_data.csv");
export const CHECKPOINT_FILE = path.join(FILES_FOLDER, "checkpoint.txt");
export const LAST_GAMEWEEK_FILE = path.join(FILES_FOLDER, "lastGameweek.txt");

if (!fs.existsSync(FILES_FOLDER)) {
  fs.mkdirSync(FILES_FOLDER, { recursive: true });
  console.log(`Created folder: ${FILES_FOLDER}`);
}

// Read the last checkpoint (last processed player ID)
export const readCheckpoint = () => {
  if (fs.existsSync(CHECKPOINT_FILE)) {
    const lastProcessed = fs.readFileSync(CHECKPOINT_FILE, "utf8");
    return parseInt(lastProcessed, 10) || 0;
  }
  return 0;
};
  
// Write the checkpoint (last processed player ID)
export const writeCheckpoint = (playerId: number) => {
  fs.writeFileSync(CHECKPOINT_FILE, playerId.toString(), "utf8");
};

// Dynamically create headers from the API response
export const createHeaders = (sampleGameweek: Omit<GameweekData, "Player_ID">) =>  {
  const headers = [{ id: "Player_ID", title: "Player_ID" }];
  Object.keys(sampleGameweek).forEach((key) => {
    headers.push({ id: key, title: key });
  }); 
  return headers;
};

// Prepare rows dynamically based on the API response
export const prepareRows = (playerId: number, gameweeks: Omit<GameweekData, "Player_ID">[]): GameweekData[] => gameweeks.map((gameweek) => ({
  Player_ID: playerId.toString(),
  ...gameweek,
}));


// Read existing data from the CSV file
export const readExistingCsv = (): Promise<Record<string, GameweekData[]>> => 
  new Promise((resolve, reject) => {
    const data: GameweekData = {} as GameweekData;
    if (!fs.existsSync(CSV_FILE)) {
      return resolve(data);
    }

    fs.createReadStream(CSV_FILE)
      .pipe(csv())
      .on("data", (row: GameweekData) => {
        const playerId = row.Player_ID;
        if (!data[playerId]) data[playerId] = [];
        data[playerId].push(row);
      })
      .on("end", () => resolve(data))
      .on("error", (error) => reject(error));
});
