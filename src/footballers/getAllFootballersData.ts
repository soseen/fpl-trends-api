import { prisma } from "../database/client.js";

export const getFootballersWithHistoryAndFixtures = async () => {
  const footballers = await prisma.footballers.findMany({
    include: {
      teams: true,
      history: { orderBy: { kickoff_time: "asc" } },
      footballer_fixtures: { orderBy: { kickoff_time: "asc" } },
    },
  });
  return footballers;
};
