import { prisma } from "../database/client.js";
import { assertCurrentPenaltyFeedReady } from "../penalties/readiness.js";

export const getTeamsData = async () => {
  await assertCurrentPenaltyFeedReady();
  return await prisma.teams.findMany({
    include: {
      team_history: true,
    },
  });
};
