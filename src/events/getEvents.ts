import { prisma } from "../database/client.js";

export const getEvents = async () => {
  return await prisma.teams.findMany();
};
