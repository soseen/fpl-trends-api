import { Blacklist, GameweekData, GameweekEvent, PlayerHistory } from "./types";
import fs from "fs";
import { createObjectCsvWriter } from "csv-writer";
import {
  BLACKLIST_FILE,
  CLEANED_DATA_FILE,
  RAW_PLAYERS_SAMPLE_FILE,
} from "./file.helpers";
export const processRawData = async () => {
  if (!fs.existsSync(RAW_PLAYERS_SAMPLE_FILE)) {
    console.error("Raw data file not found. Run fetchAndSaveRawData() first.");
    return;
  }

  const rawData: Record<string, PlayerHistory> = JSON.parse(
    fs.readFileSync(RAW_PLAYERS_SAMPLE_FILE, "utf8"),
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

    if (isInactive) {
      blacklistedPlayers.push({ ID: Number(playerId), Reason: "inactive" });
      continue; // Skip this player
    }

    const { isDeleted, isTransferManiac } = gameweeks.reduce(
      (acc, gw) => ({
        isDeleted: acc.isDeleted || gw.overall_rank === 0,
        isTransferManiac: acc.isTransferManiac || gw.event_transfers_cost >= 20,
      }),
      { isDeleted: false, isTransferManiac: false },
    );

    if (isDeleted || isTransferManiac) {
      blacklistedPlayers.push({
        ID: Number(playerId),
        Reason: isDeleted ? "deleted" : "transfer maniac",
      });
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
      { id: "event", title: "event" },
      { id: "points", title: "points" },
      { id: "total_points", title: "total_points" },
      { id: "rank", title: "rank" },
      { id: "rank_sort", title: "rank_sort" },
      { id: "overall_rank", title: "overall_rank" },
      { id: "percentile_rank", title: "percentile_rank" },
      { id: "bank", title: "bank" },
      { id: "value", title: "value" },
      { id: "event_transfers", title: "event_transfers" },
      { id: "event_transfers_cost", title: "event_transfers_cost" },
      { id: "points_on_bench", title: "points_on_bench" },
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
    append: fs.existsSync(BLACKLIST_FILE),
  });

  await blacklistCsvWriter.writeRecords(blacklistedPlayers);
  console.log(`Blacklisted players written to ${BLACKLIST_FILE}`);
};
