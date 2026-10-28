import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { prisma } from "../database/client.js";
import { rankedPopulationSql } from "../managers/rankedPopulation.js";
import { calculateBenchmarkAsync } from "./calculate.js";
import {
  pointKey,
  benchmarkSourceSchema,
  benchmarkSchema,
  CALCULATION_VERSION,
  validSquad,
  type SampleManager,
  type Stratum,
} from "./model.js";
import { AnalyticsError } from "./errors.js";
import { publishBenchmark, seasonState, type Job } from "./store.js";
import { transfersSchema } from "../managers/sourceValidation.js";

export const buildBenchmark = async (
  season: string,
  gw: number,
  job?: Job,
): Promise<string> => {
  const before = await seasonState();
  // Once historical working facts are retired, never rebuild a historical GW
  // from the surviving fragment of its old roster. Replay its frozen source.
  const [archived] = await prisma.$queryRaw<
    Array<{
      id: string;
      calculation_version: number;
      source_revision: string;
      source_payload: Uint8Array;
      curve: unknown;
    }>
  >`
    SELECT b.id,b.calculation_version,b.source_revision,b.source_payload,b.payload->'curve' AS curve
    FROM analytics_publications p JOIN analytics_benchmarks b ON b.id=p.benchmark_id
    WHERE p.season=${season} AND p.gw=${gw} AND p.gw<(SELECT MAX(id) FROM events)
      AND b.source_payload IS NOT NULL AND (b.payload->>'finalized')::boolean`;
  if (
    archived &&
    process.env["ANALYTICS_REBUILD_HISTORICAL_FROM_FACTS"] !== "true"
  ) {
    if (archived.calculation_version === CALCULATION_VERSION)
      return archived.id;
    const source = benchmarkSourceSchema.parse(
      JSON.parse(
        (
          await promisify(gunzip)(archived.source_payload, {
            maxOutputLength: 512 * 1024 ** 2,
          })
        ).toString("utf8"),
      ) as unknown,
    );
    const hash = createHash("sha256")
      .update(JSON.stringify(source))
      .digest("hex");
    if (hash !== archived.source_revision)
      throw new Error("Historical replay source checksum mismatch");
    const snapshot = await calculateBenchmarkAsync({
      ...source,
      sourceRevision: hash,
      generatedAt: new Date().toISOString(),
      finalized: true,
      points: new Map(
        source.points.map((p) => [
          pointKey(p.footballer_id, p.round),
          p.points,
        ]),
      ),
    });
    snapshot.curve = benchmarkSchema.shape.curve.parse(archived.curve);
    return publishBenchmark(snapshot, source, job, archived.id);
  }
  // A sampler upgrade replaces provenance incrementally. Keep a usable
  // generation while the finalized-GW replacement draw is still incomplete;
  // otherwise a small prefix could erase healthy comparison/EO coverage.
  const [collecting] = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT b.id FROM analytics_publications p JOIN analytics_benchmarks b ON b.id=p.benchmark_id
    JOIN events e ON e.id=p.gw
    WHERE p.season=${season} AND p.gw=${gw} AND b.calculation_version=${CALCULATION_VERSION}
      AND e.finished AND e.data_checked
      AND (SELECT value::int FROM app_metadata WHERE key='manager_sample_gw')=${gw}
      AND (SELECT value FROM app_metadata WHERE key='manager_sample_gw_finalized')='2'`;
  if (collecting) return collecting.id;
  // Carry completed follow-up cohorts forward when the latest GW sample is
  // refreshed. Their immutable inputs are archived with each generation.
  const [prior] = await prisma.$queryRaw<
    Array<{
      id: string;
      followup_payload: unknown;
    }>
  >`
    SELECT b.id,b.followup_payload FROM analytics_publications p
    JOIN analytics_benchmarks b ON b.id=p.benchmark_id
    WHERE p.season=${season} AND p.gw=${gw} AND (b.payload->>'finalized')::boolean`;
  const followedTop10k =
    prior?.followup_payload == null
      ? undefined
      : benchmarkSourceSchema.shape.followedTop10k.parse(
          prior.followup_payload,
        );
  const { snapshot, source } = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '60s'");
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
      await tx.$executeRawUnsafe("SET LOCAL work_mem = '16MB'");
      const metadata = await tx.app_metadata.findUnique({
        where: { key: "current_season" },
      });
      if (metadata?.value !== season)
        throw new AnalyticsError(
          "season_changed",
          "The season changed; this job has been retired.",
          false,
        );
      const [event] = await tx.$queryRaw<
        Array<{ population: number; finished: boolean; data_checked: boolean }>
      >(
        Prisma.sql`SELECT ${Prisma.raw(rankedPopulationSql("e"))} AS population,e.finished,e.data_checked FROM events e WHERE e.id=${gw}`,
      );
      if (!event || event.population <= 0)
        throw new AnalyticsError(
          "population_unavailable",
          "The ranked population is not available.",
        );
      const roster = await tx.$queryRaw<
        Array<{
          entry_id: number;
          sample_stratum: number;
          sample_page: number | null;
          has_transfer_history: boolean;
          has_chip_history: boolean;
        }>
      >`
      WITH sample AS (
        SELECT mp.entry_id,mp.sample_stratum,mp.sample_page,row_number() OVER (PARTITION BY mp.sample_stratum ORDER BY md5(mp.entry_id::text || ${season} || ${gw}::text)) AS n
        FROM manager_picks mp WHERE mp.gw=${gw} AND mp.sampled_at_gw=${gw} AND mp.sample_stratum BETWEEN 1 AND 3
      ) SELECT s.entry_id,s.sample_stratum,s.sample_page,ms.has_transfer_history,ms.has_chip_history FROM sample s JOIN manager_summary ms USING(entry_id)
      WHERE s.n <= CASE s.sample_stratum WHEN 1 THEN 10000 WHEN 2 THEN 10000 ELSE 20000 END
    `;
      if (roster.length === 0)
        throw new AnalyticsError(
          "sample_unavailable",
          "The manager sample has not been collected yet.",
        );
      const ids = roster.map((r) => r.entry_id);
      const batched = async <T>(
        load: (batch: number[]) => Promise<T[]>,
      ): Promise<T[]> => {
        const result: T[] = [];
        for (let i = 0; i < ids.length; i += 5000)
          for (const row of await load(ids.slice(i, i + 5000)))
            result.push(row);
        return result;
      };
      const [history, picks, captains, transfers, transferSources, players] =
        await Promise.all([
          batched((batch) =>
            tx.manager_history.findMany({
              where: { entry_id: { in: batch }, gw: { lte: gw } },
              orderBy: [{ entry_id: "asc" }, { gw: "asc" }],
            }),
          ),
          batched((batch) =>
            tx.manager_pick_elements.findMany({
              where: { entry_id: { in: batch }, gw },
            }),
          ),
          batched((batch) =>
            tx.manager_picks.findMany({
              where: { entry_id: { in: batch }, gw: { lte: gw } },
              select: { entry_id: true, gw: true, captain_element: true },
            }),
          ),
          batched((batch) =>
            tx.manager_transfers.findMany({
              where: { entry_id: { in: batch }, gw: { lte: gw } },
            }),
          ),
          tx.$queryRaw<
            Array<{ entry_id: number; payload: unknown }>
          >`SELECT entry_id,payload FROM analytics_manager_sources WHERE season=${season} AND entry_id=ANY(${ids}::int[]) AND kind='transfers'`,
          tx.$queryRaw<
            Array<{ footballer_id: number; round: number; points: number }>
          >`SELECT footballer_id,round,SUM(total_points)::int AS points FROM history WHERE round<=${gw} GROUP BY footballer_id,round ORDER BY footballer_id,round`,
        ]);
      const managers = new Map<number, SampleManager>(
        roster.map((r) => [
          r.entry_id,
          {
            entry: r.entry_id,
            ...(r.sample_page ? { cluster: r.sample_page } : {}),
            stratum: r.sample_stratum as Stratum,
            facts: [],
            picks: [],
            transfers: [],
            transfersComplete: r.has_transfer_history,
            chipsComplete: r.has_chip_history,
          },
        ]),
      );
      const captainMap = new Map(
        captains.map((p) => [`${p.entry_id}:${p.gw}`, p.captain_element]),
      );
      for (const h of history)
        managers.get(h.entry_id)?.facts.push({
          gw: h.gw,
          points: h.points,
          rank: h.overall_rank,
          transfers: h.event_transfers,
          hits: h.event_transfers_cost,
          bench: h.points_on_bench,
          chip: h.active_chip,
          captain: captainMap.get(`${h.entry_id}:${h.gw}`) ?? null,
        });
      for (const p of picks)
        managers.get(p.entry_id)?.picks.push({
          element: p.element_id,
          position: p.position,
          multiplier: p.multiplier,
          captain: p.is_captain,
          vice: p.is_vice,
        });
      for (const t of transfers)
        managers
          .get(t.entry_id)
          ?.transfers.push({ gw: t.gw, in: t.in_element, out: t.out_element });
      for (const row of transferSources) {
        const manager = managers.get(row.entry_id);
        if (manager)
          manager.transfers = transfersSchema
            .parse(row.payload)
            .filter((t) => t.event <= gw)
            .map((t) => ({
              gw: t.event,
              in: t.element_in,
              out: t.element_out,
            }));
      }
      // Raw Prisma rows duplicate the normalized replay model. Release them
      // before validating/cloning that model, especially for late-season GWs.
      history.length = 0;
      picks.length = 0;
      captains.length = 0;
      transfers.length = 0;
      transferSources.length = 0;
      captainMap.clear();
      const eligible = [...managers.values()]
        .filter((m) => m.facts.some((f) => f.gw === gw))
        .sort((a, b) => a.entry - b.entry);
      if (event.finished && event.data_checked) {
        const currentPoints = new Map(
          players
            .filter((p) => p.round === gw)
            .map((p) => [p.footballer_id, p.points]),
        );
        const mismatches = eligible.filter((manager) => {
          if (!validSquad(manager.picks)) return false;
          const fact = manager.facts.find((f) => f.gw === gw);
          if (!fact || fact.hits === null) return false;
          const gross = manager.picks.reduce(
            (total, pick) =>
              total + pick.multiplier * (currentPoints.get(pick.element) ?? 0),
            0,
          );
          return gross - fact.hits !== fact.points;
        }).length;
        if (mismatches > 0) {
          console.error(
            JSON.stringify({
              event: "analytics_source_score_mismatch",
              gw,
              mismatches,
              sourceManagers: eligible.length,
            }),
          );
          throw new AnalyticsError(
            "sample_reconciliation_failed",
            "Finalized sampled squad scores do not reconcile with official manager history. The last publication is retained.",
          );
        }
      }
      for (const manager of eligible) {
        manager.picks.sort((a, b) => a.position - b.position);
        manager.transfers.sort(
          (a, b) => a.gw - b.gw || a.in - b.in || a.out - b.out,
        );
        const chipGws = new Set(
          manager.facts
            .filter((f) => f.chip === "wildcard" || f.chip === "freehit")
            .map((f) => f.gw),
        );
        const expected = manager.facts
          .filter((f) => !chipGws.has(f.gw))
          .reduce((s, f) => s + (f.transfers ?? 0), 0);
        if (
          manager.transfers.filter((t) => !chipGws.has(t.gw)).length !==
          expected
        )
          manager.transfersComplete = false;
      }
      const state = await tx.app_metadata.findMany({
        where: {
          key: { in: ["manager_sample_gw", "manager_sample_gw_finalized"] },
        },
      });
      const sampleGw = Number(
        state.find((s) => s.key === "manager_sample_gw")?.value ?? 0,
      );
      const sampleFinal =
        state.find((s) => s.key === "manager_sample_gw_finalized")?.value ===
        "1";
      const source = benchmarkSourceSchema.parse({
        format: 1,
        checkSquadScores: true,
        season,
        gw,
        population: event.population,
        managers: eligible,
        ...(event.finished && event.data_checked && followedTop10k
          ? { followedTop10k }
          : {}),
        points: players,
      });
      managers.clear();
      eligible.length = 0;
      players.length = 0;
      const sourceRevision = createHash("sha256")
        .update(JSON.stringify(source))
        .digest("hex");
      const result = await calculateBenchmarkAsync({
        checkSquadScores: true,
        season,
        gw,
        population: event.population,
        finalized:
          event.finished &&
          event.data_checked &&
          (sampleGw > gw || (sampleGw === gw && sampleFinal)),
        generatedAt: new Date().toISOString(),
        sourceRevision,
        managers: source.managers,
        followedTop10k: source.followedTop10k,
        points: new Map(
          source.points.map((p) => [
            pointKey(p.footballer_id, p.round),
            p.points,
          ]),
        ),
      });
      if (!result.exposures.length) {
        console.warn(
          JSON.stringify({
            event: "analytics_sample_exposure_unavailable",
            season,
            gw,
            reason: "Incomplete or unreconciled finalized squads",
            sampleCounts: result.sampleCounts,
          }),
        );
        if (result.finalized)
          throw new AnalyticsError(
            "sample_reconciliation_failed",
            "Finalized sample squads are incomplete or do not reconcile with official scores. The last publication is retained.",
          );
      }
      if (event.finished && event.data_checked) {
        const scores = new Map<number, number[]>();
        for (const manager of source.managers) {
          const rank = manager.facts.find((f) => f.gw === gw)?.rank;
          if (!rank || rank <= 0) continue;
          const score = manager.facts.reduce((s, f) => s + f.points, 0);
          const ranks = scores.get(score) ?? [];
          ranks.push(rank);
          scores.set(score, ranks);
        }
        result.curve = {
          capturedAt: result.generatedAt,
          points: [...scores]
            .map(([score, ranks]) => {
              ranks.sort((a, b) => a - b);
              const middle = Math.floor(ranks.length / 2);
              return {
                score,
                rank:
                  ranks.length % 2
                    ? ranks[middle]!
                    : (ranks[middle - 1]! + ranks[middle]!) / 2,
              };
            })
            .sort((a, b) => a.score - b.score),
        };
      }
      return { snapshot: result, source };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 180_000,
      maxWait: 5000,
    },
  );
  if ((await seasonState()).bulkRevision !== before.bulkRevision)
    throw new AnalyticsError(
      "bulk_refresh_in_progress",
      "Player data changed while the benchmark was building; it will be retried.",
    );
  const previous = await prisma.$queryRaw<
    Array<{ id: string; finalized: boolean; source_revision: string }>
  >`SELECT b.id,b.source_revision,(b.payload->>'finalized')::boolean AS finalized FROM analytics_publications p JOIN analytics_benchmarks b ON b.id=p.benchmark_id WHERE p.season=${season} AND p.gw=${gw} AND b.calculation_version=${CALCULATION_VERSION}`;
  if (
    previous[0]?.source_revision === snapshot.sourceRevision &&
    previous[0].finalized === snapshot.finalized
  )
    return previous[0].id;
  return publishBenchmark(snapshot, source, job, prior?.id);
};
