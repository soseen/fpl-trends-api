import "dotenv/config";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import axios from "axios";
import { prisma } from "../database/client.js";
import { netPointsForEvent } from "../managers/activityFilter.js";
import { fetchEntryHistory } from "../managers/fetchManager.js";
import { fetchEntryTransfers } from "../managers/fetchTransfers.js";
import { delay } from "../utils.js";
import { calculateFollowedTop10k } from "./calculate.js";
import {
  benchmarkSchema,
  benchmarkSourceSchema,
  sampleManagerSchema,
  hasCompleteTransferWindow,
  pointKey,
  type SampleManager,
} from "./model.js";
import { publishBenchmark, seasonState } from "./store.js";

const SAMPLE_SIZE = 300;
type Source = ReturnType<typeof benchmarkSourceSchema.parse>;

// Only accept an archived census, rather than selecting from an unknown,
// potentially outcome-biased subset. Stable hashing chooses the follow-up
// before observing any results in the selected range.
export const selectFollowup = (anchor: Source): SampleManager[] => {
  const elite = anchor.managers.filter((m) => {
    const rank = m.facts.find((f) => f.gw === anchor.gw)?.rank;
    return (
      m.stratum === 1 &&
      rank !== null &&
      rank !== undefined &&
      rank > 0 &&
      rank <= 10000
    );
  });
  if (
    elite.length !== 10000 ||
    new Set(elite.map((m) => m.entry)).size !== 10000
  )
    throw new Error(`GW${anchor.gw}: no complete archived Top 10k census`);
  const key = (m: SampleManager) =>
    createHash("sha256")
      .update(`${anchor.season}:${anchor.gw}:${m.entry}:top10k-followup-v1`)
      .digest("hex");
  return elite
    .map((m) => ({ m, key: key(m) }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.m.entry - b.m.entry)
    .slice(0, SAMPLE_SIZE)
    .map(({ m }) => m);
};

const readSource = async (season: string, gw: number) => {
  const [row] = await prisma.$queryRaw<
    Array<{
      id: string;
      source_revision: string;
      source_payload: Uint8Array | null;
      payload: unknown;
    }>
  >`
    SELECT b.id,b.source_revision,b.source_payload,b.payload FROM analytics_publications p
    JOIN analytics_benchmarks b ON b.id=p.benchmark_id WHERE p.season=${season} AND p.gw=${gw}`;
  if (!row?.source_payload)
    throw new Error(`GW${gw}: published replay source unavailable`);
  const source = benchmarkSourceSchema.parse(
    JSON.parse(
      (
        await promisify(gunzip)(row.source_payload, {
          maxOutputLength: 512 * 1024 ** 2,
        })
      ).toString("utf8"),
    ) as unknown,
  );
  const hash = createHash("sha256")
    .update(JSON.stringify(source))
    .digest("hex");
  if (
    hash !== row.source_revision ||
    source.season !== season ||
    source.gw !== gw
  )
    throw new Error(`GW${gw}: replay source failed verification`);
  const payload = benchmarkSchema.parse(row.payload);
  if (!payload.finalized)
    throw new Error(`GW${gw}: benchmark is not finalized`);
  return { ...row, source, payload };
};

export const followTop10k = async (
  start: number,
  end: number,
  pause: (ms: number) => Promise<unknown> = delay,
): Promise<string> => {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 2 ||
    end < start ||
    end > 38
  )
    throw new Error("Expected 2 <= start <= end <= 38");
  const { season, bulkRevision } = await seasonState();
  const anchor = await (async () => {
    const archived = await readSource(season, start - 1);
    return {
      id: archived.id,
      source_revision: archived.source_revision,
      selected: selectFollowup(archived.source),
    };
  })();
  const selected = anchor.selected;
  const selectedEntries = selected.map((m) => m.entry);
  const kind = `top10k-followup-v1:${end}`;
  const cached = await prisma.$queryRaw<
    Array<{ entry_id: number; payload: unknown }>
  >`
    SELECT entry_id,payload FROM analytics_manager_sources
    WHERE season=${season} AND kind=${kind} AND entry_id=ANY(${selectedEntries}::int[])
      AND fetched_at > now()-interval '7 days'`;
  const cachedByEntry = new Map(
    cached.map((row) => [row.entry_id, row.payload]),
  );
  const managers: SampleManager[] = [];
  for (const original of selected) {
    let saved: SampleManager;
    const value = cachedByEntry.get(original.entry);
    if (value !== undefined) {
      saved = sampleManagerSchema.parse(value);
      if (saved.entry !== original.entry)
        throw new Error("Follow-up cache identity mismatch");
    } else {
      let history;
      let transfers;
      try {
        history = await fetchEntryHistory(original.entry);
        await pause(100);
        transfers = await fetchEntryTransfers(original.entry);
        await pause(100);
      } catch (error) {
        // A small bounded number of deleted entries may be missing. Transient
        // failures abort the pass; completed entries survive for the retry.
        if (axios.isAxiosError(error) && error.response?.status === 404)
          continue;
        throw error;
      }
      if (transfers.some((transfer) => transfer.entry !== original.entry))
        throw new Error(
          `Entry ${original.entry}: transfer source belongs to another manager`,
        );
      const chips = new Map(
        history.chips.map((chip) => [chip.event, chip.name]),
      );
      const facts = history.current
        .filter((f) => f.event <= end)
        .map((f) => ({
          gw: f.event,
          points: netPointsForEvent(f),
          rank: f.overall_rank,
          transfers: f.event_transfers,
          hits: f.event_transfers_cost,
          bench: f.points_on_bench,
          chip: chips.get(f.event) ?? null,
          captain: null,
        }));
      if (
        Array.from({ length: end - start + 2 }, (_, i) => start - 1 + i).some(
          (gw) => !facts.some((f) => f.gw === gw),
        )
      )
        throw new Error(`Entry ${original.entry}: incomplete history`);
      const moves = transfers
        .filter((t) => t.event <= end)
        .map((t) => ({ gw: t.event, in: t.element_in, out: t.element_out }));
      saved = {
        entry: original.entry,
        stratum: 1,
        facts,
        picks: [],
        transfers: moves,
        transfersComplete: true,
        chipsComplete: true,
      };
      await prisma.$executeRaw`INSERT INTO analytics_manager_sources(season,entry_id,kind,payload,finalized,fetched_at)
      VALUES (${season},${original.entry},${kind},${JSON.stringify(saved)}::jsonb,true,now())
      ON CONFLICT(season,entry_id,kind) DO UPDATE SET payload=excluded.payload,finalized=true,fetched_at=now()`;
    }
    const anchorFact = original.facts.find((f) => f.gw === start - 1);
    const facts = saved.facts.map((fact) => ({ ...fact }));
    const at = facts.findIndex((f) => f.gw === start - 1);
    if (
      !anchorFact?.rank ||
      at < 0 ||
      Array.from({ length: end - start + 1 }, (_, i) => start + i).some(
        (gw) => !facts.some((f) => f.gw === gw),
      )
    )
      throw new Error(`Entry ${original.entry}: incomplete history`);
    facts[at]!.rank = anchorFact.rank;
    managers.push({
      ...saved,
      facts,
      transfersComplete: hasCompleteTransferWindow(
        { facts, transfers: saved.transfers },
        start,
        end,
      ),
    });
  }
  if (managers.length < 297)
    throw new Error(
      `Only ${managers.length} of 300 selected managers could be followed`,
    );
  const target = await readSource(season, end);
  const followedTop10k = benchmarkSourceSchema.shape.followedTop10k.parse(
    [
      ...(target.source.followedTop10k ?? []).filter(
        (f) => f.startGw !== start,
      ),
      {
        startGw: start,
        anchorRevision: anchor.source_revision,
        selectedEntries,
        managers,
      },
    ].sort((a, b) => a.startGw - b.startGw),
  );
  // Preserve schema property order for the replay checksum without cloning the
  // entire validated source a second time.
  const source: Source = {
    format: target.source.format,
    checkSquadScores: target.source.checkSquadScores,
    season: target.source.season,
    gw: target.source.gw,
    population: target.source.population,
    managers: target.source.managers,
    followedTop10k,
    points: target.source.points,
  };
  const sourceRevision = createHash("sha256")
    .update(JSON.stringify(source))
    .digest("hex");
  const replacement = calculateFollowedTop10k(
    managers,
    start,
    end,
    new Map(
      source.points.map((p) => [pointKey(p.footballer_id, p.round), p.points]),
    ),
  );
  const snapshot = target.payload;
  const range = snapshot.ranges.find((r) => r.startGw === start);
  if (!range)
    throw new Error("Published benchmark is missing the requested range");
  range.cohorts.top10k = replacement.cohort;
  range.transferMeans.top10k = replacement.transferMean;
  range.transferCoverage.top10k = replacement.transferCoverage;
  snapshot.generatedAt = new Date().toISOString();
  snapshot.sourceRevision = sourceRevision;
  const state = await seasonState();
  if (state.season !== season || state.bulkRevision !== bulkRevision)
    throw new Error("Season or player data changed during collection; retry");
  return publishBenchmark(snapshot, source, undefined, target.id, {
    gw: start - 1,
    id: anchor.id,
  });
};

// Called only after the regular collector has no sample work left. Prepare at
// most one missing range per run, prioritising the latest finalized GW.
const findMissingTop10k = async (
  excluded: Set<string>,
): Promise<{ start: number; end: number } | null> => {
  const { season } = await seasonState();
  const available = await prisma.$queryRaw<
    Array<{ gw: number; payload: unknown }>
  >`
    SELECT p.gw,b.payload FROM analytics_publications p
    JOIN analytics_benchmarks b ON b.id=p.benchmark_id
    WHERE p.season=${season} AND b.calculation_version=${benchmarkSchema.shape.version.value}
      AND (b.payload->>'finalized')::boolean
    ORDER BY p.gw DESC`;
  const known = new Set(available.map((row) => row.gw));
  const anchors = new Map<number, boolean>();
  for (const { gw: end, payload } of available) {
    if (end < 2) continue;
    const target = benchmarkSchema.parse(payload);
    let followedStarts: Set<number> | undefined;
    for (let start = 2; start <= end; start++) {
      const range = target.ranges.find((r) => r.startGw === start);
      if (!range) continue;
      const cohort = range.cohorts.top10k;
      const chips =
        start <= 19
          ? [
              cohort.wildcards_h1_rate,
              cohort.free_hits_h1_rate,
              cohort.bench_boosts_h1_rate,
              cohort.triple_captains_h1_rate,
            ]
          : [];
      if (end > 19)
        chips.push(
          cohort.wildcards_h2_rate,
          cohort.free_hits_h2_rate,
          cohort.bench_boosts_h2_rate,
          cohort.triple_captains_h2_rate,
        );
      const missing = [
        cohort.avg_total_points,
        cohort.avg_gw_score,
        cohort.avg_transfers,
        cohort.avg_hits,
        cohort.avg_bench,
        range.transferMeans.top10k,
        ...chips,
      ].some((value) => value === null);
      if (excluded.has(`${start}:${end}`) || !known.has(start - 1) || !missing)
        continue;
      if (!followedStarts)
        followedStarts = new Set(
          (await readSource(season, end)).source.followedTop10k?.map(
            (s) => s.startGw,
          ) ?? [],
        );
      if (followedStarts.has(start)) continue;
      let eligible = anchors.get(start - 1);
      if (eligible === undefined) {
        const anchor = await readSource(season, start - 1);
        try {
          selectFollowup(anchor.source);
          eligible = true;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.includes("no complete archived Top 10k census")
          )
            throw error;
          eligible = false;
        }
        anchors.set(start - 1, eligible);
      }
      if (eligible) return { start, end };
    }
  }
  return null;
};

export const followOneMissingTop10k = async (
  pause: (ms: number) => Promise<unknown> = delay,
): Promise<boolean> => {
  const excluded = new Set<string>();
  for (;;) {
    const candidate = await findMissingTop10k(excluded);
    if (!candidate) return false;
    const { start, end } = candidate;
    try {
      const id = await followTop10k(start, end, pause);
      console.info(
        JSON.stringify({ event: "top10k_followup_published", start, end, id }),
      );
      return true;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Only "))
        throw error;
      console.warn(
        JSON.stringify({
          event: "top10k_followup_insufficient",
          start,
          end,
          cause: error.message,
        }),
      );
      excluded.add(`${start}:${end}`);
    }
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const arg = (name: string) =>
      Number(
        process.argv.find((s) => s.startsWith(`--${name}=`))?.split("=")[1],
      );
    const start = arg("start"),
      end = arg("end");
    const id = await followTop10k(start, end);
    console.info(
      JSON.stringify({ event: "top10k_followup_published", start, end, id }),
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
