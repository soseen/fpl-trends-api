import axios from "axios";
import { GameweekData, PlayerHistory } from "./types";
import { BootstrapStaticData } from "./bootstrapStatic/types";

export const getPlayerHistory = async (playerId: number) => {
  try {
    const response = await axios.get(
      `https://fantasy.premierleague.com/api/entry/${playerId}/history/`,
    );
    return response.data as PlayerHistory;
  } catch (error) {
    console.error(
      `Failed to fetch data for player ID ${playerId}:`,
      (error as Error)?.message,
    );
    throw error;
  }
};

export const getBootstrapStaticData = async () => {
  try {
    const response = await axios.get<BootstrapStaticData>(
      "https://fantasy.premierleague.com/api/bootstrap-static/",
    );
    return response?.data;
  } catch (error) {
    console.error("Failed to fetch Bootstrap Data", (error as Error)?.message);
    throw error;
  }
};

export const getBasicInfo = async () => {
  const data = await getBootstrapStaticData();
  const lastGameweek: number =
    (data?.events?.find((gw) => !gw?.finished)?.id ?? 1) - 1;
  const totalPlayers: number = data?.total_players ?? 0;
  return { totalPlayers, lastGameweek, events: data.events };
};
