import { currentBenchmarks } from "../analytics/store.js";
import { observeFplBackoff } from "./fplBackoff.js";
import { summarySchema, historySchema } from "./sourceValidation.js";
import axios, { type AxiosInstance } from "axios";
import type { PlayerHistory } from "../types.js";
import type { EntrySummary, LeagueStandingsResponse } from "./types.js";

const BASE =
  process.env["FPL_API_BASE_URL"] ?? "https://fantasy.premierleague.com/api";
const USER_AGENT = "fpl-trends/1.0 (+https://fpltrends.live)";
const REQUEST_TIMEOUT_MS = 15_000;

const client: AxiosInstance = axios.create({
  timeout: REQUEST_TIMEOUT_MS,
  headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
});
observeFplBackoff(client);

type CachedValue<T> = {
  value: T;
  expiresAt: number;
};

const MANAGER_FETCH_TTL_MS = 60 * 1000;

const summaryCache = new Map<string, CachedValue<EntrySummary>>();
const historyCache = new Map<string, CachedValue<PlayerHistory>>();
const summaryInflight = new Map<string, Promise<EntrySummary>>();
const historyInflight = new Map<string, Promise<PlayerHistory>>();

const getFresh = <T>(
  cache: Map<string, CachedValue<T>>,
  entryId: string,
): T | null => {
  const cached = cache.get(entryId);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    cache.delete(entryId);
    return null;
  }
  return cached.value;
};

const loadCached = async <T>(
  entryId: number,
  cache: Map<string, CachedValue<T>>,
  inflight: Map<string, Promise<T>>,
  loader: () => Promise<T>,
): Promise<T> => {
  const key = `${currentBenchmarks()?.season ?? "collector"}:${entryId}`;
  const cached = getFresh(cache, key);
  if (cached !== null) return cached;

  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = loader()
    .then((value) => {
      if (cache.size >= 1000) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, {
        value,
        expiresAt: Date.now() + MANAGER_FETCH_TTL_MS,
      });
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
};

export const fetchEntrySummary = async (
  entryId: number,
): Promise<EntrySummary> => {
  return loadCached(entryId, summaryCache, summaryInflight, async () => {
    const { data } = await client.get<EntrySummary>(
      `${BASE}/entry/${entryId}/`,
    );
    return summarySchema.parse(data);
  });
};

export const fetchEntryHistory = async (
  entryId: number,
): Promise<PlayerHistory> => {
  return loadCached(entryId, historyCache, historyInflight, async () => {
    const { data } = await client.get<PlayerHistory>(
      `${BASE}/entry/${entryId}/history/`,
    );
    return historySchema.parse(data);
  });
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
