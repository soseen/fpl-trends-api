import { prisma } from "../database/client.js";

export const getTeamsData = async () => {
  return await prisma.teams.findMany({
    include: {
      team_history: true,
    },
  });
};
