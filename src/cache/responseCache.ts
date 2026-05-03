import crypto from "crypto";
import type { Request, Response } from "express";

// Entry layout shared between global (e.g. /footballersData) and parameterised
// (e.g. /api/manager/:id/comparison?start=...&end=...) cached responses.
//
// `expiresAt` is set to Number.POSITIVE_INFINITY for the global keys (they're
// only ever invalidated by `invalidateCache()` from the populate flow) and
// to `Date.now() + MANAGER_TTL_MS` for manager keys.
type Entry = {
  body: unknown;
  etag: string;
  json: string;
  expiresAt: number;
};

// Insertion-ordered Map gives us LRU-by-touch semantics: re-inserting a key
// moves it to the back, so the iterator's first item is always the LRU
// candidate for eviction. The global keys are never evicted in practice
// because the manager keys saturate the cap first (we have ~5 global keys
// vs hundreds of distinct (entry, range) tuples per active session).
const store = new Map<string, Entry>();

// In-flight de-dup: when several requests for the same cache key arrive
// during a cold miss, only the first kicks off `loader()`; the others
// await the same Promise and serve the same body. Critical for the My
// Trends page where TanStack Query may fire identical requests within
// ~10 ms when the slider is dragged.
const inflight = new Map<string, Promise<Entry>>();

// Manager-keyed entries are bounded by an LRU cap and a TTL. The cap
// protects the process from a runaway distinct-key set (e.g. an attacker
// scanning entry IDs); the TTL keeps the data fresh enough to track
// 30-min populate cycles. Global keys (footballersData etc.) are
// unaffected — they re-set expiresAt to Number.POSITIVE_INFINITY.
const MANAGER_TTL_MS = 5 * 60 * 1000;
const MANAGER_MAX_ENTRIES = 1000;

export const invalidateCache = (): void => {
  store.clear();
  inflight.clear();
  console.info("🧹 Response cache invalidated");
};

const buildEtag = (json: string): string =>
  `"${crypto.createHash("sha1").update(json).digest("hex")}"`;

const buildEntry = (body: unknown, ttlMs: number): Entry => {
  const json = JSON.stringify(body);
  return {
    body,
    json,
    etag: buildEtag(json),
    expiresAt: ttlMs === Infinity ? Infinity : Date.now() + ttlMs,
  };
};

const evictExpired = (key: string, entry: Entry | undefined): boolean => {
  if (!entry) return false;
  if (entry.expiresAt > Date.now()) return true;
  store.delete(key);
  return false;
};

const enforceLruCap = (): void => {
  while (store.size > MANAGER_MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) return;
    store.delete(oldest);
  }
};

const writeCached = (req: Request, res: Response, entry: Entry): void => {
  res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
  res.setHeader("ETag", entry.etag);

  if (req.headers["if-none-match"] === entry.etag) {
    res.status(304).end();
    return;
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).send(entry.json);
};

// Returns either a fresh entry from cache, the existing in-flight promise,
// or kicks off a new load (caching the result). Single-flight on miss.
const loadOrShare = (
  key: string,
  ttlMs: number,
  loader: () => Promise<unknown>,
): Promise<Entry> => {
  const cached = store.get(key);
  if (evictExpired(key, cached)) {
    // Touch for LRU: move to MRU end of the insertion-ordered Map.
    store.delete(key);
    store.set(key, cached!);
    return Promise.resolve(cached!);
  }

  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = loader()
    .then((body) => {
      const entry = buildEntry(body, ttlMs);
      store.set(key, entry);
      enforceLruCap();
      return entry;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
};

// Global-keyed cache, used for whole-endpoint responses that share one key
// (e.g. /footballersData). Entries live until `invalidateCache()` is called
// by the populate flow.
export const cachedJson = async (
  req: Request,
  res: Response,
  key: string,
  loader: () => Promise<unknown>,
): Promise<void> => {
  const entry = await loadOrShare(key, Infinity, loader);
  writeCached(req, res, entry);
};

// Manager-endpoint cache. Keyed on `(endpoint, entryId, startGw, endGw)` so
// each (range, manager) combination is cached independently. TTL'd at 5 min
// (matching the populate cron cadence) and bounded to MANAGER_MAX_ENTRIES
// to cap the process's worst-case memory under a runaway request pattern.
export const cachedManagerJson = async (
  req: Request,
  res: Response,
  endpoint: string,
  entryId: number,
  startGw: number,
  endGw: number,
  loader: () => Promise<unknown>,
): Promise<void> => {
  const key = `${endpoint}:${entryId}:${startGw}:${endGw}`;
  const entry = await loadOrShare(key, MANAGER_TTL_MS, loader);
  writeCached(req, res, entry);
};
