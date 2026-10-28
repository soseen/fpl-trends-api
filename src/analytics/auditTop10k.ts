import "dotenv/config";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { prisma } from "../database/client.js";
import { effectiveSampleSize } from "./calculate.js";
import {
  benchmarkSourceSchema,
  populationSizes,
  type SampleManager,
} from "./model.js";
import { seasonState } from "./store.js";

type Source = ReturnType<typeof benchmarkSourceSchema.parse>;

// These diagnostics measure availability, not statistical accuracy. In
// particular, managers present in both archives are not a random follow-up:
// inclusion in the later sample can depend on their subsequent rank.
export const auditTop10kRange = (anchor: Source, end: Source) => {
  if (anchor.season !== end.season || anchor.gw >= end.gw)
    throw new Error("Expected an earlier anchor in the same season");
  const rankAt = (m: SampleManager, gw: number) =>
    m.facts.find((f) => f.gw === gw)?.rank ?? 0;
  const isElite = (m: SampleManager, gw: number) => {
    const rank = rankAt(m, gw);
    return rank > 0 && rank <= 10_000;
  };
  const anchorMembers = anchor.managers.filter((m) => isElite(m, anchor.gw));
  const endMembers = end.managers.filter((m) => isElite(m, anchor.gw));
  const endIds = new Set(end.managers.map((m) => m.entry));
  const counts = [1, 2, 3].map(
    (s) => end.managers.filter((m) => m.stratum === s).length,
  );
  const sizes = populationSizes(end.population);
  const weighted = endMembers.map((m) => ({
    weight: sizes[m.stratum] / (counts[m.stratum - 1] ?? 1),
  }));
  const completeHistory = (m: SampleManager) =>
    Array.from(
      { length: end.gw - anchor.gw },
      (_, i) => anchor.gw + i + 1,
    ).every((gw) => m.facts.some((f) => f.gw === gw));
  return {
    startGw: anchor.gw + 1,
    endGw: end.gw,
    anchorManagers: anchorMembers.length,
    anchorWithKnownPage: anchorMembers.filter((m) => m.cluster !== undefined)
      .length,
    anchorPages: new Set(
      anchorMembers.flatMap((m) =>
        m.cluster === undefined ? [] : [m.cluster],
      ),
    ).size,
    anchorAlsoInEndSample: anchorMembers.filter((m) => endIds.has(m.entry))
      .length,
    endSamplePriorElite: endMembers.length,
    endSampleEffectiveSize: Number(effectiveSampleSize(weighted).toFixed(2)),
    endSampleCompleteHistory: endMembers.filter(completeHistory).length,
    endSampleCompleteTransfers: endMembers.filter((m) => m.transfersComplete)
      .length,
  };
};

const loadSource = async (season: string, gw: number): Promise<Source> => {
  const [row] = await prisma.$queryRaw<
    Array<{ source_payload: Uint8Array | null; source_revision: string }>
  >`SELECT b.source_payload,b.source_revision FROM analytics_publications p
    JOIN analytics_benchmarks b ON b.id=p.benchmark_id
    WHERE p.season=${season} AND p.gw=${gw}`;
  if (!row?.source_payload)
    throw new Error(`GW${gw}: replay source unavailable`);
  const json = (
    await promisify(gunzip)(row.source_payload, {
      maxOutputLength: 512 * 1024 ** 2,
    })
  ).toString("utf8");
  const source = benchmarkSourceSchema.parse(JSON.parse(json) as unknown);
  if (
    createHash("sha256").update(JSON.stringify(source)).digest("hex") !==
    row.source_revision
  )
    throw new Error(`GW${gw}: replay source checksum mismatch`);
  if (source.season !== season || source.gw !== gw)
    throw new Error(`GW${gw}: replay source identity mismatch`);
  return source;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { season } = await seasonState();
    const latest =
      (await prisma.events.aggregate({ _max: { id: true } }))._max.id ?? 0;
    const arg = process.argv.find((s) => s.startsWith("--end="));
    const endGw = arg ? Number(arg.slice("--end=".length)) : latest;
    if (!Number.isInteger(endGw) || endGw < 2 || endGw > latest)
      throw new Error(
        "Use --end=N with a published end GW between 2 and the latest GW",
      );
    const end = await loadSource(season, endGw);
    for (let gw = 1; gw < endGw; gw++) {
      const anchor = await loadSource(season, gw);
      console.info(JSON.stringify(auditTop10kRange(anchor, end)));
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
