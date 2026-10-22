import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { prisma } from "../database/client.js";
import {
  benchmarkSourceSchema,
  populationSizes,
  strata,
  type SampleManager,
} from "./model.js";
import { estimateWeightedMidrank } from "../managers/rangeStats.js";

// A held-out entry never contributes to the distribution used to predict it.
// This reports empirical full-season rank error, not a promised interval for
// arbitrary ranges (which have no public census ground truth).
export const calibrateRanks = (
  source: ReturnType<typeof benchmarkSourceSchema.parse>,
) => {
  const isHoldout = (m: SampleManager) =>
    createHash("sha256")
      .update(
        `${source.season}:${source.gw}:${m.stratum}:${m.cluster ?? Math.ceil((m.facts.find((f) => f.gw === source.gw)?.rank ?? m.entry) / 50)}`,
      )
      .digest()
      .readUInt32LE(0) %
      5 ===
    0;
  const train = source.managers.filter((m) => !isHoldout(m));
  const test = source.managers.filter(isHoldout);
  const score = (m: SampleManager) => m.facts.reduce((s, f) => s + f.points, 0);
  const distributions = strata.map((stratum) =>
    train
      .filter((m) => m.stratum === stratum)
      .map(score)
      .sort((a, b) => a - b),
  );
  const bound = (a: number[], n: number, inclusive: boolean) => {
    let lo = 0,
      hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (a[mid]! < n || (inclusive && a[mid] === n)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const errors: number[] = [];
  for (const manager of test) {
    const actual = manager.facts.find((f) => f.gw === source.gw)?.rank;
    if (!actual || actual <= 0) continue;
    const points = score(manager);
    const rows = distributions.map((scores, i) => ({
      stratum: i + 1,
      sample_size: scores.length,
      strictly_higher: scores.length - bound(scores, points, true),
      tied: bound(scores, points, true) - bound(scores, points, false),
    }));
    const predicted = estimateWeightedMidrank(
      rows,
      populationSizes(source.population),
      source.population,
    ).rangeRank;
    if (predicted !== null) errors.push(Math.abs(predicted - actual));
  }
  errors.sort((a, b) => a - b);
  return {
    season: source.season,
    gw: source.gw,
    trainingByStratum: distributions.map((d) => d.length),
    holdoutUnit: "standings_page_cluster",
    inferredClusters: source.managers.filter((m) => m.cluster === undefined)
      .length,
    heldOut: errors.length,
    meanAbsoluteRankError: errors.length
      ? errors.reduce((s, n) => s + n, 0) / errors.length
      : null,
    medianAbsoluteRankError: errors[Math.floor(errors.length / 2)] ?? null,
    p95AbsoluteRankError: errors[Math.floor(errors.length * 0.95)] ?? null,
    p95PopulationPercent: errors.length
      ? (100 * (errors[Math.floor(errors.length * 0.95)] ?? 0)) /
        source.population
      : null,
  };
};
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const id = process.argv[2];
    if (!id || !/^[0-9a-f-]{36}$/i.test(id))
      throw new Error("Usage: npm run analytics:calibrate -- <benchmark UUID>");
    const [row] = await prisma.$queryRaw<
      Array<{ source_payload: Uint8Array | null }>
    >`SELECT source_payload FROM analytics_benchmarks WHERE id=${id}::uuid`;
    if (!row?.source_payload) throw new Error("No retained source input");
    const source = benchmarkSourceSchema.parse(
      JSON.parse(
        (
          await promisify(gunzip)(row.source_payload, {
            maxOutputLength: 512 * 1024 ** 2,
          })
        ).toString("utf8"),
      ) as unknown,
    );
    const report = calibrateRanks(source);
    console.info(JSON.stringify(report));
    if (!report.heldOut) process.exitCode = 1;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
