import axios from "axios";
import { GameweekData } from "./types";

export const getBasicInfo = async () => {
  const response = await axios.get("https://fantasy.premierleague.com/api/bootstrap-static/");
  const lastGameweek: number = parseInt(response.data?.events?.find(gw => !gw?.finished)?.id ?? 1) - 1;
  const totalPlayers = response?.data?.total_players ?? 0;
  return { totalPlayers, lastGameweek };
}

export const getPlayerHistory = async (playerId: number) => {
  try {
    const response = await axios.get(`https://fantasy.premierleague.com/api/entry/${playerId}/history/`);
    return response.data.current as Omit<GameweekData, "Player_ID">[];
  } catch (error) {
    console.error(`Failed to fetch data for player ID ${playerId}:`, (error as Error)?.message);
    return null;
  }
}