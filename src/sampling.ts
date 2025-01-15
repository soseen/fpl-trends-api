import fs from "fs";
import { createObjectCsvWriter } from "csv-writer";
import { BLACKLIST_FILE, SAMPLE } from "./file.helpers";

//Half of the sampled players should consist of the top 30% of IDs (the likelihood that a player is active is higher). The other half is the remaining players whose ID is not higher than 60% of Total Players.
export const getSamplePlayers = (
  totalPlayers: number,
  blacklist: Set<number>,
): number[] => {
  const maxSampleId = Math.floor(totalPlayers * 0.6); // Top limit of eligible IDs (60% of totalPlayers)
  const top30PercentStart = Math.floor(totalPlayers * 0.3); // Start of the top 30% of IDs

  // Create eligible players list excluding blacklisted IDs
  const eligiblePlayers = Array.from(
    { length: maxSampleId },
    (_, i) => i + 1,
  ).filter((id) => !blacklist.has(id));

  // Split eligible players into two groups
  const top30PercentPlayers = eligiblePlayers.filter(
    (id) => id <= top30PercentStart,
  );
  const remainingPlayers = eligiblePlayers.filter(
    (id) => id > top30PercentStart,
  );

  // Shuffle function for randomness
  const shuffleArray = (array: number[]) => {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  };

  // Shuffle both groups
  const shuffledTop30 = shuffleArray(top30PercentPlayers);
  const shuffledRemaining = shuffleArray(remainingPlayers);

  // Select random samples
  const sampleTop30 = shuffledTop30.slice(0, 5000); // 50k from top 30%
  const sampleRemaining = shuffledRemaining.slice(0, 5000); // 50k from below 60%

  const sampledIds = [...sampleTop30, ...sampleRemaining];

  // Write sampled IDs to a CSV file
  const csvWriter = createObjectCsvWriter({
    path: SAMPLE,
    header: [{ id: "ID", title: "ID" }],
  });

  const records = sampledIds.map((id) => ({ ID: id }));
  csvWriter.writeRecords(records).then(() => {
    console.log(`Sampled IDs written to ${SAMPLE}`);
  });

  return sampledIds;
};

// Helper to read and write the blacklist
export const readBlacklist = (): Set<number> => {
  if (!fs.existsSync(BLACKLIST_FILE)) return new Set();
  const blacklist = fs
    .readFileSync(BLACKLIST_FILE, "utf8")
    .split("\n")
    .map((line) => parseInt(line.split(",")[0], 10));
  return new Set(blacklist);
};

export const writeToBlacklist = (playerId: number, reason: string) => {
  const blacklistWriter = createObjectCsvWriter({
    path: BLACKLIST_FILE,
    header: [
      { id: "ID", title: "ID" },
      { id: "Reason", title: "Reason" },
    ],
    append: fs.existsSync(BLACKLIST_FILE),
  });
  blacklistWriter.writeRecords([{ ID: playerId, Reason: reason }]);
};
