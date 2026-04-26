import axios, { type AxiosInstance } from "axios";
import type { PlayerHistory } from "../types.js";
import type { EntrySummary, LeagueStandingsResponse } from "./types.js";

const BASE = "https://fantasy.premierleague.com/api";
const USER_AGENT = "fpl-trends/1.0 (+https://fpltrends.live)";
const REQUEST_TIMEOUT_MS = 15_000;

const client: AxiosInstance = axios.create({
  timeout: REQUEST_TIMEOUT_MS,
  headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
});

export const fetchEntrySummary = async (
  entryId: number,
): Promise<EntrySummary> => {
  const { data } = await client.get<EntrySummary>(`${BASE}/entry/${entryId}/`);
  return data;
};

export const fetchEntryHistory = async (
  entryId: number,
): Promise<PlayerHistory> => {
  const { data } = await client.get<PlayerHistory>(
    `${BASE}/entry/${entryId}/history/`,
  );
  return data;
};

export const fetchLeagueStandingsPage = async (
  leagueId: number,
  page: number,
): Promise<LeagueStandingsResponse> => {
  const { data } = await client.get<LeagueStandingsResponse>(
    `${BASE}/leagues-classic/${leagueId}/standings/`,
    { params: { page_standings: page } },
  );
  return data;
};

// 314 is the global "Overall" classic league.
export const OVERALL_LEAGUE_ID = 314;
