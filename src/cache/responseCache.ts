import crypto from "crypto";
import type { Request, Response } from "express";

type Entry = { body: unknown; etag: string; json: string };

const store = new Map<string, Entry>();

export const invalidateCache = (): void => {
  store.clear();
  console.info("🧹 Response cache invalidated");
};

const buildEtag = (json: string): string =>
  `"${crypto.createHash("sha1").update(json).digest("hex")}"`;

export const cachedJson = async (
  req: Request,
  res: Response,
  key: string,
  loader: () => Promise<unknown>,
): Promise<void> => {
  let entry = store.get(key);

  if (!entry) {
    const body = await loader();
    const json = JSON.stringify(body);
    entry = { body, json, etag: buildEtag(json) };
    store.set(key, entry);
  }

  res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
  res.setHeader("ETag", entry.etag);

  if (req.headers["if-none-match"] === entry.etag) {
    res.status(304).end();
    return;
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).send(entry.json);
};
