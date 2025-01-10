import axios from "axios";
import { GameweekData } from "./types";

export const getTotalPlayers = async () => {
  const response = await axios.get("https://fantasy.premierleague.com/api/bootstrap-static/");
  // return response.data.total_players;
  return 500;
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