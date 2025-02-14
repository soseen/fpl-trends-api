import { prisma } from "../database/client";

export const getEvents = async () => {
  return await prisma.events.findMany();
};
