import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { prisma } from "../database/client.js";
import {
  benchmarkSchema,
  benchmarkSourceSchema,
  pointKey,
  type Benchmark,
} from "./model.js";
import { calculateBenchmarkAsync } from "./calculate.js";

// Pure replay never reads mutable working facts or changes a publication.
export const replayBenchmark = async (
  payload: unknown,
  compressed: Uint8Array,
): Promise<Benchmark> => {
  const published = benchmarkSchema.parse(payload);
  const json = (
    await promisify(gunzip)(compressed, { maxOutputLength: 512 * 1024 ** 2 })
  ).toString("utf8");
  const source = benchmarkSourceSchema.parse(JSON.parse(json) as unknown);
  if (
    createHash("sha256").update(JSON.stringify(source)).digest("hex") !==
    published.sourceRevision
  )
    throw new Error("Archived source checksum mismatch");
  const replayed = await calculateBenchmarkAsync({
    ...source,
    generatedAt: published.generatedAt,
    sourceRevision: published.sourceRevision,
    finalized: published.finalized,
    points: new Map(
      source.points.map((p) => [pointKey(p.footballer_id, p.round), p.points]),
    ),
  });
  // The curve is independent calibration data retained in the published payload.
  replayed.curve = published.curve;
  return replayed;
};
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const id = process.argv[2];
    if (!id || !/^[0-9a-f-]{36}$/i.test(id))
      throw new Error("Usage: npm run analytics:replay -- <benchmark UUID>");
    const [row] = await prisma.$queryRaw<
      Array<{ payload: unknown; source_payload: Uint8Array | null }>
    >`SELECT payload,source_payload FROM analytics_benchmarks WHERE id=${id}::uuid`;
    if (!row?.source_payload)
      throw new Error("No replay source is retained for this generation");
    const replay = await replayBenchmark(row.payload, row.source_payload);
    const expected = benchmarkSchema.parse(row.payload);
    if (JSON.stringify(replay) !== JSON.stringify(expected))
      throw new Error("Replay differs from the published generation");
    console.info(
      JSON.stringify({
        event: "analytics_replay_verified",
        id,
        gw: replay.gw,
        season: replay.season,
      }),
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
