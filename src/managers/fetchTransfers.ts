import axios, { type AxiosInstance } from "axios";

const BASE = "https://fantasy.premierleague.com/api";
const USER_AGENT = "fpl-trends/1.0 (+https://fpltrends.live)";
const REQUEST_TIMEOUT_MS = 15_000;

const client: AxiosInstance = axios.create({
  timeout: REQUEST_TIMEOUT_MS,
  headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
});

// Subset of the /entry/{id}/transfers/ payload we actually persist.
// FPL returns more fields (`time`, `time_diff_in_days`) which we drop —
// the GW (`event`) is enough to anchor the transfer in time and we never
// surface the wall-clock timestamp.
export type FplTransfer = {
  element_in: number;
  element_in_cost: number;
  element_out: number;
  element_out_cost: number;
  entry: number;
  event: number;
};

export const fetchEntryTransfers = async (
  entryId: number,
): Promise<FplTransfer[]> => {
  const { data } = await client.get<FplTransfer[]>(
    `${BASE}/entry/${entryId}/transfers/`,
  );
  return data;
};
