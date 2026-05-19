import axios from "axios";
import type { Request, Response } from "express";

const ALLOWED_PLAYER_IMAGE_SIZES = new Set(["40x40", "110x140", "500x500"]);
const SUCCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MISS_TTL_SECONDS = 60 * 60;
const MAX_CACHE_ENTRIES = 400;

type CachedPlayerImage = {
  body: Buffer;
  contentType: string;
  etag?: string;
  expiresAt: number;
};

const cache = new Map<string, CachedPlayerImage>();

const touchCacheEntry = (key: string, entry: CachedPlayerImage): void => {
  cache.delete(key);
  cache.set(key, entry);
};

const readCacheEntry = (key: string): CachedPlayerImage | null => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  touchCacheEntry(key, entry);
  return entry;
};

const writeCacheEntry = (key: string, entry: CachedPlayerImage): void => {
  cache.set(key, entry);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    cache.delete(oldest);
  }
};

const writeImageResponse = (
  req: Request,
  res: Response,
  entry: CachedPlayerImage,
): void => {
  res.setHeader("Cache-Control", "public, max-age=604800, immutable");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Timing-Allow-Origin", "*");
  res.setHeader("Content-Type", entry.contentType);
  res.setHeader("Content-Length", entry.body.length);
  if (entry.etag) res.setHeader("ETag", entry.etag);

  if (entry.etag && req.headers["if-none-match"] === entry.etag) {
    res.status(304).end();
    return;
  }

  res.status(200).send(entry.body);
};

const parsePlayerImageRequest = (
  req: Request,
): { code: number; size: string } | null => {
  const size = req.params["size"];
  const codeParam = req.params["code"];
  const code = Number(codeParam);

  if (!size || !ALLOWED_PLAYER_IMAGE_SIZES.has(size)) return null;
  if (!Number.isInteger(code) || code < 1 || code > 10_000_000) return null;

  return { code, size };
};

export const getPlayerImage = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const parsed = parsePlayerImageRequest(req);
  if (!parsed) {
    res.status(400).json({ error: "Invalid player image request." });
    return;
  }

  const { code, size } = parsed;
  const key = `${size}:${code}`;
  const cached = readCacheEntry(key);
  if (cached) {
    writeImageResponse(req, res, cached);
    return;
  }

  const upstreamUrl = `https://resources.premierleague.com/premierleague25/photos/players/${size}/${code}.png`;

  try {
    const response = await axios.get<ArrayBuffer>(upstreamUrl, {
      responseType: "arraybuffer",
      timeout: 10_000,
      validateStatus: () => true,
    });

    if (response.status !== 200) {
      res.setHeader("Cache-Control", `public, max-age=${MISS_TTL_SECONDS}`);
      res.status(response.status).end();
      return;
    }

    const contentTypeHeader = response.headers["content-type"];
    const etagHeader = response.headers["etag"];
    const entry: CachedPlayerImage = {
      body: Buffer.from(response.data),
      contentType:
        typeof contentTypeHeader === "string" ? contentTypeHeader : "image/png",
      etag: typeof etagHeader === "string" ? etagHeader : undefined,
      expiresAt: Date.now() + SUCCESS_TTL_MS,
    };

    writeCacheEntry(key, entry);
    writeImageResponse(req, res, entry);
  } catch (error: unknown) {
    console.error(
      `[playerImageProxy] Failed to fetch player image ${size}/${code}:`,
      (error as Error).message,
    );
    res.status(502).json({ error: "Failed to fetch player image." });
  }
};
