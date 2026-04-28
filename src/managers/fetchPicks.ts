import axios, { type AxiosInstance } from "axios";

const BASE = "https://fantasy.premierleague.com/api";
const USER_AGENT = "fpl-trends/1.0 (+https://fpltrends.live)";
const REQUEST_TIMEOUT_MS = 15_000;

const client: AxiosInstance = axios.create({
  timeout: REQUEST_TIMEOUT_MS,
  headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
});

export type EntryEventPick = {
  element: number;
  position: number;
  multiplier: number; // 0 = benched, 1 = playing, 2 = captain, 3 = triple captain
  is_captain: boolean;
  is_vice_captain: boolean;
};

export type EntryEventPicksResponse = {
  active_chip: string | null;
  picks: EntryEventPick[];
  entry_history: {
    points: number;
    total_points: number;
    rank: number | null;
    overall_rank: number | null;
  };
};

// Subset of /entry/{id}/event/{gw}/picks/ used for ingestion + per-query
// captain calc. The endpoint returns the manager's full XV plus chip status
// for that GW; we only persist captain choice + active chip.
export const fetchEntryEventPicks = async (
  entryId: number,
  gw: number,
): Promise<EntryEventPicksResponse> => {
  const { data } = await client.get<EntryEventPicksResponse>(
    `${BASE}/entry/${entryId}/event/${gw}/picks/`,
  );
  return data;
};

// Helper: extract the captain/vice/multiplier from a picks payload. Returns
// nulls for unusual rows (e.g. a manager who somehow has no captain pick —
// rare but defensive).
export const summarizePicks = (
  picks: EntryEventPick[],
): {
  captain_element: number | null;
  vice_captain_element: number | null;
  captain_multiplier: number | null;
} => {
  let captain_element: number | null = null;
  let vice_captain_element: number | null = null;
  let captain_multiplier: number | null = null;

  for (const p of picks) {
    if (p.is_captain) {
      captain_element = p.element;
      captain_multiplier = p.multiplier;
    }
    if (p.is_vice_captain) {
      vice_captain_element = p.element;
    }
  }

  return { captain_element, vice_captain_element, captain_multiplier };
};
