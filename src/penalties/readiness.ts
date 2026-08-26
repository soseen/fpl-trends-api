import { prisma } from "../database/client.js";

export const assertCurrentPenaltyFeedReady = async (): Promise<string> => {
  const currentSeason = await prisma.app_metadata.findUnique({
    where: { key: "current_season" },
    select: { value: true },
  });
  if (!currentSeason) {
    throw new Error("[nonPenalty] No current season is configured.");
  }
  const sync = await prisma.penalty_feed_sync.findUnique({
    where: { season: currentSeason.value },
  });
  if (!sync || sync.completed_fixture_count !== sync.mapped_fixture_count) {
    throw new Error(
      `[nonPenalty] Penalty-feed coverage is not ready for ${currentSeason.value}.`,
    );
  }
  return currentSeason.value;
};
