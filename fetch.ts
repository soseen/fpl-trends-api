import axios from "axios";

export const getTotalPlayers = async () => {
  const response = await axios.get("https://fantasy.premierleague.com/api/bootstrap-static/");
  // return response.data.total_players;
  return 500;
}

export const getPlayerHistory = async (playerId: string | number) => {
  try {
    const response = await axios.get(`https://fantasy.premierleague.com/api/entry/${playerId}/history/`);
    return response.data.current;
  } catch (error) {
    console.error(`Failed to fetch data for player ID ${playerId}:`, error.message);
    return null;
  }
}