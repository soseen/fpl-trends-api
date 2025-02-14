import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

// Manual implementation of __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FILES_FOLDER = path.join(__dirname, "data");
export const CSV_FILE = path.join(
  FILES_FOLDER,
  "fpl_players_gameweek_data.csv",
);
export const CHECKPOINT_FILE = path.join(FILES_FOLDER, "checkpoint.txt");
export const LAST_GAMEWEEK_FILE = path.join(FILES_FOLDER, "lastGameweek.txt");
export const BLACKLIST_FILE = path.join(FILES_FOLDER, "blacklist.csv");
export const SAMPLE = path.join(FILES_FOLDER, "sample.csv");
export const RAW_PLAYERS_SAMPLE_FILE = path.join(
  FILES_FOLDER,
  "raw_players_sample.json",
);
export const RAW_PLAYERS_ALL_FILE = path.join(
  FILES_FOLDER,
  "raw_players_all.json",
);
export const CLEANED_DATA_FILE = path.join(FILES_FOLDER, "cleaned_players.csv");
export const RAW_BOOTSTRAP_STATIC_FILE = path.join(
  FILES_FOLDER,
  "raw_bootstrap_static.json",
);
export const RAW_FOOTBALLERS_FILE = path.join(
  FILES_FOLDER,
  "raw_footballers.json",
);

if (!fs.existsSync(FILES_FOLDER)) {
  fs.mkdirSync(FILES_FOLDER, { recursive: true });
  console.log(`Created folder: ${FILES_FOLDER}`);
}

export const readCheckpoint = () => {
  if (fs.existsSync(CHECKPOINT_FILE)) {
    const lastProcessed = fs.readFileSync(CHECKPOINT_FILE, "utf8");
    return parseInt(lastProcessed, 10) || 0;
  }
  return 0;
};

export const writeCheckpoint = (playerId: number) => {
  fs.writeFileSync(CHECKPOINT_FILE, playerId.toString(), "utf8");
};
