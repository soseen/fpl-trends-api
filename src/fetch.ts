import axios from "axios";
import type { BootstrapStaticData } from "./bootstrapStatic/types.js";

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
