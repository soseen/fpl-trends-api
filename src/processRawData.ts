import { Blacklist, GameweekData, GameweekEvent, PlayerHistory } from "./types";
import fs from "fs";
import { createObjectCsvWriter } from "csv-writer";
import {
  BLACKLIST_FILE,
  CLEANED_DATA_FILE,
  RAW_DATA_FILE,
} from "./file.helpers";
export const processRawData = async () => {
  if (!fs.existsSync(RAW_DATA_FILE)) {
    console.error("Raw data file not found. Run fetchAndSaveRawData() first.");
    return;
  }

  const rawData: Record<string, PlayerHistory> = JSON.parse(
    fs.readFileSync(RAW_DATA_FILE, "utf8"),
  );
  const blacklistedPlayers: Blacklist[] = [];
  const cleanedData: GameweekData[] = [];

  for (const [playerId, playerHistory] of Object.entries(rawData)) {
    const gameweeks = playerHistory?.current;

    if (!gameweeks || gameweeks.length === 0) {
      console.warn(`No gameweeks data for player ID ${playerId}`);
      continue;
    }

    const isInactive =
      gameweeks.length >= 6 &&
      gameweeks.slice(-6).every((gw) => gw.event_transfers === 0);
    const isDeleted = gameweeks.some((gw) => gw.overall_rank === 0);

    if (isInactive) {
      blacklistedPlayers.push({ ID: Number(playerId), Reason: "inactive" });
      continue; // Skip this player
    }

    if (isDeleted) {
      blacklistedPlayers.push({ ID: Number(playerId), Reason: "deleted" });
      continue; // Skip this player
    }

    cleanedData.push(
      ...gameweeks.map((gw) => ({ Player_ID: playerId, ...gw })),
    );
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
      { id: "rank_sort", title: "Rank Sort" },
      { id: "overall_rank", title: "Overall Rank" },
      { id: "percentile_rank", title: "Percentile Rank" },
      { id: "bank", title: "Bank" },
      { id: "value", title: "Value" },
      { id: "event_transfers", title: "Event Transfers" },
      { id: "event_transfers_cost", title: "Event Transfers Cost" },
      { id: "points_on_bench", title: "Points on Bench" },
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
