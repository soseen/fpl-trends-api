import { prisma } from "../database/client";

export const getFootballersWithHistoryAndFixtures = async () => {
  const footballers = await prisma.footballers.findMany({
    include: {
      teams: true,
      history: { orderBy: { kickoff_time: "asc" } },
      footballer_fixtures: {
        include: { fixtures: true },
        orderBy: { fixtures: { event: "asc" } },
      },
    },
  });

  return footballers.map((footballer) => ({
    ...footballer,
    footballer_fixtures: footballer.footballer_fixtures.map((f) => ({
      ...f.fixtures,
      is_home: f.is_home,
      difficulty: f.difficulty,
    })),
  }));
};
