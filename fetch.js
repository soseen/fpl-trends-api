const axios = require("axios");

async function getTotalPlayers() {
  const response = await axios.get("https://fantasy.premierleague.com/api/bootstrap-static/");
  // return response.data.total_players;
  return 500;
}

async function getPlayerHistory(playerId) {
  try {
    const response = await axios.get(`https://fantasy.premierleague.com/api/entry/${playerId}/history/`);
    return response.data.current;
  } catch (error) {
    console.error(`Failed to fetch data for player ID ${playerId}:`, error.message);
    return null;
  }
}
  
module.exports = { getTotalPlayers, getPlayerHistory }