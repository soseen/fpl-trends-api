import axios from "axios";
import type { PlayerHistory } from "./types.js";
import type { BootstrapStaticData } from "./bootstrapStatic/types.js";

export const getPlayerHistory = async (
  playerId: number,
): Promise<PlayerHistory> => {
  try {
    const response = await axios.get<PlayerHistory>(
      `https://fantasy.premierleague.com/api/entry/${playerId}/history/`,
    );
    return response.data;
  } catch (error) {
    console.error(
      `Failed to fetch data for player ID ${playerId}:`,
      (error as Error).message,
    );
    throw error;
  }
};

export const getBootstrapStaticData =
  async (): Promise<BootstrapStaticData> => {
    try {
      const response = await axios.get<BootstrapStaticData>(
        "https://fantasy.premierleague.com/api/bootstrap-static/",
      );
      return response.data;
    } catch (error) {
      console.error("Failed to fetch Bootstrap Data", (error as Error).message);
      throw error;
    }
  };

export const getBasicInfo = async () => {
  const data = await getBootstrapStaticData();
  const lastGameweek: number =
    (data.events.find((gw) => !gw.finished)?.id ?? 1) - 1;
  const totalPlayers: number = data.total_players ?? 0;
  return { totalPlayers, lastGameweek, events: data.events };
};
