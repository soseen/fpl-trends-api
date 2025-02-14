import fs from "fs";
import { Footballer } from "./types";
import { getFootballer, getFootballersIds } from "./utils";
import { RAW_FOOTBALLERS_FILE } from "../file.helpers";
import { delay } from "../utils";

const BATCH_SIZE = 32;
const DELAY_MS = 60;
const MAX_RETRIES = 3;

export const fetchFootballers = async () => {
  try {
    //Get footballers ids from the generated raw bootstrap static data
    const footballerIds = getFootballersIds();

    if (fs.existsSync(RAW_FOOTBALLERS_FILE)) {
      fs.unlinkSync(RAW_FOOTBALLERS_FILE);
    }

    const rawData: Record<number, Footballer> = {};

    // Process in batches
    for (let i = 0; i < footballerIds.length; i += BATCH_SIZE) {
      const batch = footballerIds.slice(i, i + BATCH_SIZE);
      console.log(
        `Processing batch: ${i + 1} - ${Math.min(i + BATCH_SIZE, footballerIds.length)}`,
      );

      let retries = 0;
      let success = false;

      while (retries < MAX_RETRIES && !success) {
        try {
          await Promise.all(
            batch.map(async (footballerId: number) => {
              const footballer: Footballer = await getFootballer(footballerId);

              if (!footballer) {
                throw new Error(`No data for player ID ${footballerId}`);
              }

              rawData[footballerId] = footballer; // Save fetched data to the raw data object
            }),
          );

          // Save the raw data file after processing each batch
          fs.writeFileSync(
            RAW_FOOTBALLERS_FILE,
            JSON.stringify(rawData, null, 2),
          );
          console.log(
            `Batch ${i + 1} - ${i + BATCH_SIZE + 1} saved to raw data file.`,
          );

          // Batch succeeded, break out of retry loop
          success = true;
        } catch (error) {
          retries++;
          console.error(
            `Error processing batch ${i + 1}. Retry ${retries}/${MAX_RETRIES}. Error: ${(error as Error).message}`,
          );
          if (retries >= MAX_RETRIES) {
            console.error(
              `Batch ${i + 1} failed after ${MAX_RETRIES} retries. Exiting process.`,
            );
            return; // Exit the entire process if retries exceed max limit
          }
          await delay(500 + retries * 2000);
        }
      }

      await delay(DELAY_MS);
    }
  } catch (error) {
    console.error(
      `There was an error trying to fetch footballers: ${(error as Error).message}`,
    );
    return;
  }

  console.log("Raw footballers data fetching completed.");
};
