import type { Footballer } from "./types.js";
import axios from "axios";
import fs from "fs";
import { RAW_BOOTSTRAP_STATIC_FILE } from "../file.helpers.js";
import type { BootstrapStaticData } from "../bootstrapStatic/types.js";

export const getFootballersIds = () => {
  const rawData = fs.readFileSync(RAW_BOOTSTRAP_STATIC_FILE, "utf-8");
  const bootstrapStaticData: BootstrapStaticData = JSON.parse(rawData);

  if (bootstrapStaticData.elements.length === 0) {
    throw new Error("No footballers found in the elements array.");
  }

  // bootstrap-static is grouped by club, not sorted by element ID. Players
  // added after the initial release can therefore have IDs greater than the
  // final array item's ID. Read the actual IDs so every listed player gets an
  // element-summary request.
  return bootstrapStaticData.elements.map((footballer) => footballer.id);
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
