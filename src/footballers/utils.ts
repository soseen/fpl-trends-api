import type { Footballer } from "./types.js";
import axios from "axios";
import fs from "fs";
import { RAW_BOOTSTRAP_STATIC_FILE } from "../file.helpers.js";
import type { BootstrapStaticData } from "../bootstrapStatic/types.js";

export const getFootballersIds = () => {
  const rawData = fs.readFileSync(RAW_BOOTSTRAP_STATIC_FILE, "utf-8");
  const bootstrapStaticData: BootstrapStaticData = JSON.parse(rawData);

  const lastFootballer = bootstrapStaticData.elements.at(-1);
  if (!lastFootballer) {
    throw new Error("No footballers found in the elements array.");
  }

  const lastFootballerId = lastFootballer.id;

  const footballerIds = Array.from(
    { length: lastFootballerId },
    (_, i) => i + 1,
  );

  return footballerIds;
};

export const getFootballer = async (footballerID: number) => {
  try {
    const response = await axios.get<Footballer>(
      `https://fantasy.premierleague.com/api/element-summary/${footballerID}/`,
    );
    return response.data;
  } catch (error) {
    console.error(
      `Failed to fetch data for footballer ID ${footballerID}:`,
      (error as Error)?.message,
    );
    throw error;
  }
};
