import axios from "axios";
export const getPlayerHistory = async (playerId) => {
    try {
        const response = await axios.get(`https://fantasy.premierleague.com/api/entry/${playerId}/history/`);
        return response.data;
    }
    catch (error) {
        console.error(`Failed to fetch data for player ID ${playerId}:`, error?.message);
        throw error;
    }
};
export const getBootstrapStaticData = async () => {
    try {
        const response = await axios.get("https://fantasy.premierleague.com/api/bootstrap-static/");
        return response?.data;
    }
    catch (error) {
        console.error("Failed to fetch Bootstrap Data", error?.message);
        throw error;
    }
};
export const getBasicInfo = async () => {
    const data = await getBootstrapStaticData();
    const lastGameweek = (data?.events?.find((gw) => !gw?.finished)?.id ?? 1) - 1;
    const totalPlayers = data?.total_players ?? 0;
    return { totalPlayers, lastGameweek, events: data.events };
};
