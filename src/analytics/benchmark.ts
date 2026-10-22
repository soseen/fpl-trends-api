import "dotenv/config";
import { performance } from "node:perf_hooks";
import { calculateBenchmark } from "./calculate.js";
import { type SampleManager } from "./model.js";

// CPU/memory smoke benchmark, no network/database and no claim of statistical
// calibration. Override the default 40k to compare development machines.
const count = Number(process.env["BENCHMARK_MANAGERS"] ?? 40000);
if (!Number.isInteger(count) || count < 3 || count > 40000)
  throw new Error("BENCHMARK_MANAGERS must be 3..40000");
const managers: SampleManager[] = Array.from({ length: count }, (_, i) => ({
  entry: i + 1,
  stratum: i < count / 4 ? 1 : i < count / 2 ? 2 : 3,
  transfersComplete: true,
  chipsComplete: true,
  facts: Array.from({ length: 38 }, (_, j) => ({
    gw: j + 1,
    points: 30 + ((i + j) % 65),
    rank: i < count / 4 ? i + 1 : i < count / 2 ? 10001 + i : 100001 + i * 101,
    transfers: 1,
    hits: 0,
    bench: i % 15,
    chip: null,
    captain: 1 + (i % 5),
  })),
  picks: Array.from({ length: 15 }, (_, j) => ({
    element: j + 1,
    position: j + 1,
    multiplier: j === i % 5 ? 2 : j < 11 ? 1 : 0,
    captain: j === i % 5,
    vice: j === (i + 1) % 5,
  })),
  transfers: Array.from({ length: 37 }, (_, j) => ({
    gw: j + 2,
    in: 1 + ((j + i) % 15),
    out: 1 + ((j + i + 1) % 15),
  })),
}));
const points = new Map(
  Array.from({ length: 15 * 38 }, (_, i) => [
    `${1 + Math.floor(i / 38)}:${1 + (i % 38)}`,
    (i % 14) - 2,
  ]),
);
const start = performance.now();
const result = calculateBenchmark({
  season: "2026-27",
  gw: 38,
  population: 15000000,
  generatedAt: new Date().toISOString(),
  sourceRevision: "synthetic",
  finalized: true,
  managers,
  points,
});
console.info(
  JSON.stringify({
    managers: count,
    gameweeks: 38,
    rangeCount: result.ranges.length,
    durationMs: Math.round(performance.now() - start),
    heapMiB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    payloadBytes: Buffer.byteLength(JSON.stringify(result)),
  }),
);
