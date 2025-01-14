import { Blacklist, GameweekData } from './types';
import fs from "fs";
import { createObjectCsvWriter } from "csv-writer";
import { RAW_DATA_FILE } from './file.helpers';

const CLEANED_DATA_FILE = "cleaned_data.csv";
const BLACKLIST_FILE = "blacklist.csv";

export const processRawData = async () => {
  if (!fs.existsSync(RAW_DATA_FILE)) {
    console.error("Raw data file not found. Run fetchAndSaveRawData() first.");
    return;
  }

  const rawData: GameweekData[] = JSON.parse(fs.readFileSync(RAW_DATA_FILE, "utf8"));
  const blacklistedPlayers: Blacklist[] = [];
  const cleanedData: GameweekData[] = [];

  for (const [playerId, gameweeks] of Object.entries(rawData)) {
    const isInactive =
      gameweeks.length >= 6 && gameweeks.slice(-6).every((gw) => gw.event_transfers === 0);
    const isDeleted = gameweeks.some((gw) => gw.overall_rank === 0);

    if (isInactive) {
      blacklistedPlayers.push({ ID: Number(playerId), Reason: "inactive" });
      continue; // Skip this player
    }

    if (isDeleted) {
      blacklistedPlayers.push({ ID: Number(playerId), Reason: "deleted" });
      continue; // Skip this player
    }

    cleanedData.push(...gameweeks.map((gw) => ({ Player_ID: playerId, ...gw })));
  }

  // Write cleaned data to CSV
  const cleanedCsvWriter = createObjectCsvWriter({
    path: CLEANED_DATA_FILE,
    header: [
      { id: "Player_ID", title: "Player_ID" },
      { id: "event", title: "Gameweek" },
      { id: "points", title: "Points" },
      { id: "total_points", title: "Total Points" },
      { id: "rank", title: "Rank" },
      { id: "overall_rank", title: "Overall Rank" },
      { id: "event_transfers", title: "Event Transfers" },
    ],
  });

  await cleanedCsvWriter.writeRecords(cleanedData);
  console.log(`Cleaned data written to ${CLEANED_DATA_FILE}`);

  // Write blacklisted players to CSV
  const blacklistCsvWriter = createObjectCsvWriter({
    path: BLACKLIST_FILE,
    header: [
      { id: "ID", title: "ID" },
      { id: "Reason", title: "Reason" },
    ],
  });

  await blacklistCsvWriter.writeRecords(blacklistedPlayers);
  console.log(`Blacklisted players written to ${BLACKLIST_FILE}`);
};
