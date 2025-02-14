import { prisma } from "../database/client";

export const getFootballersWithHistoryAndFixtures = async () => {
  const footballers = await prisma.footballers.findMany({
    include: {
      teams: true,
      history: true,
      footballer_fixtures: { include: { fixtures: true } },
    },
  });

  console.log(footballers);

  return footballers.map((footballer) => ({
    ...footballer,
    footballer_fixtures: footballer.footballer_fixtures.map((f) => f.fixtures),
  }));
};
