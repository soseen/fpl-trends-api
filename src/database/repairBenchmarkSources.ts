import "dotenv/config";
import { createHash } from "node:crypto";
import { prisma } from "./client.js";
import { seasonState, enqueue } from "../analytics/store.js";
import { pointKey } from "../analytics/model.js";
import { fetchEntryHistory } from "../managers/fetchManager.js";
import {
  fetchEntryEventPicks,
  summarizePicks,
} from "../managers/fetchPicks.js";
import { persistPickElements } from "../managers/persistPickElements.js";
import { delay } from "../utils.js";

// Offline, resumable repair of the exact bounded publication roster. Never
// walks the legacy population, drops provenance, or silently repairs scores
// from our own calculations. The official history remains the source of truth.
try {
  const gw = Number(
    process.argv.find((a) => a.startsWith("--gw="))?.split("=")[1],
  );
  if (!Number.isInteger(gw) || gw < 1 || gw > 38)
    throw new Error("Provide --gw=N (1..38); --apply enables writes");
  const { season } = await seasonState();
  const event = await prisma.events.findUnique({ where: { id: gw } });
  if (!event?.finished || !event.data_checked)
    throw new Error("Source repair requires an officially finalized gameweek");
  const roster = await prisma.$queryRaw<Array<{ entry_id: number }>>`
    WITH sample AS (
      SELECT entry_id,sample_stratum,row_number() OVER (
        PARTITION BY sample_stratum ORDER BY md5(entry_id::text || ${season} || ${gw}::text)
      ) AS n FROM manager_picks
      WHERE gw=${gw} AND sampled_at_gw=${gw} AND sample_stratum BETWEEN 1 AND 3
    ) SELECT entry_id FROM sample
    WHERE n<=CASE sample_stratum WHEN 1 THEN 10000 WHEN 2 THEN 10000 ELSE 20000 END
    ORDER BY entry_id`;
  if (!roster.length || roster.length > 40_000)
    throw new Error("Invalid bounded repair roster");
  const rosterHash = createHash("sha256")
    .update(JSON.stringify(roster))
    .digest("hex");
  const checkpointKey = `analytics_source_repair:${season}:${gw}:${rosterHash}`;
  const checkpoint = await prisma.app_metadata.findUnique({
    where: { key: checkpointKey },
  });
  const cursor = Number(checkpoint?.value ?? 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new Error("Invalid repair checkpoint");
  const remaining = roster.filter((r) => r.entry_id > cursor);
  console.info(
    JSON.stringify({
      event: "source_repair_plan",
      season,
      gw,
      roster: roster.length,
      remaining: remaining.length,
      apply: process.argv.includes("--apply"),
    }),
  );
  if (process.argv.includes("--apply")) {
    const playerRows = await prisma.$queryRaw<
      Array<{ footballer_id: number; round: number; points: number }>
    >`
      SELECT footballer_id,round,SUM(total_points)::int points FROM history
      WHERE round=${gw} GROUP BY footballer_id,round`;
    const points = new Map(
      playerRows.map((p) => [pointKey(p.footballer_id, p.round), p.points]),
    );
    let repairedPicks = 0;
    for (let offset = 0; offset < remaining.length; offset += 8) {
      const batch = remaining.slice(offset, offset + 8);
      // Every batch settles before moving its checkpoint. A failed batch is
      // safely retried in full; no failed entry is skipped on resume.
      const settled = await Promise.allSettled(
        batch.map(async ({ entry_id: entry }) => {
          const [history, official] = await Promise.all([
            fetchEntryHistory(entry),
            fetchEntryEventPicks(entry, gw),
          ]);
          const current = history.current.find((f) => f.event === gw);
          if (!current)
            throw new Error(`Entry ${entry} has no official GW${gw} history`);
          const chips = new Map(history.chips.map((c) => [c.event, c.name]));
          const facts = history.current.map((f) => ({
            gw: f.event,
            points: f.points - f.event_transfers_cost,
            rank: f.overall_rank,
            transfers: f.event_transfers,
            hits: f.event_transfers_cost,
            bench: f.points_on_bench,
            chip: chips.get(f.event) ?? null,
          }));
          await prisma.$executeRaw`
          INSERT INTO manager_history(entry_id,gw,points,overall_rank,event_transfers,event_transfers_cost,points_on_bench,active_chip)
          SELECT ${entry},f.gw,f.points,f.rank,f.transfers,f.hits,f.bench,f.chip
          FROM jsonb_to_recordset(${JSON.stringify(facts)}::jsonb) AS f(gw int,points int,rank int,transfers int,hits int,bench int,chip text)
          ON CONFLICT(entry_id,gw) DO UPDATE SET points=excluded.points,overall_rank=excluded.overall_rank,event_transfers=excluded.event_transfers,event_transfers_cost=excluded.event_transfers_cost,points_on_bench=excluded.points_on_bench,active_chip=excluded.active_chip
          WHERE (manager_history.points,manager_history.overall_rank,manager_history.event_transfers,manager_history.event_transfers_cost,manager_history.points_on_bench,manager_history.active_chip)
          IS DISTINCT FROM (excluded.points,excluded.overall_rank,excluded.event_transfers,excluded.event_transfers_cost,excluded.points_on_bench,excluded.active_chip)`;
          const officialGross = official.picks.reduce(
            (s, p) =>
              s + p.multiplier * (points.get(pointKey(p.element, gw)) ?? 0),
            0,
          );
          if (
            official.entry_history.points !== current.points ||
            officialGross !== current.points
          )
            throw new Error(
              `Official player/squad/history scores disagree for entry ${entry}, GW${gw}`,
            );
          await persistPickElements(entry, gw, official.picks);
          await prisma.manager_picks.update({
            where: { entry_id_gw: { entry_id: entry, gw } },
            data: {
              ...summarizePicks(official.picks),
              active_chip: official.active_chip,
            },
          });
          repairedPicks++;
        }),
      );
      const failed = settled.find((r) => r.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      await prisma.app_metadata.upsert({
        where: { key: checkpointKey },
        create: { key: checkpointKey, value: String(batch.at(-1)!.entry_id) },
        update: { value: String(batch.at(-1)!.entry_id) },
      });
      if (offset % 800 === 0 || offset + batch.length === remaining.length)
        console.info(
          JSON.stringify({
            event: "source_repair_progress",
            gw,
            completed: roster.length - remaining.length + offset + batch.length,
            total: roster.length,
            repairedPicks,
          }),
        );
      await delay(300);
    }
    // Explicitly allow the next rebuild to read these repaired facts rather
    // than replaying an older frozen source. The worker is restarted with this
    // switch only for the audited repair window.
    await enqueue({
      key: `benchmark:${season}:${gw}`,
      kind: "benchmark",
      season,
      start: gw,
      end: gw,
    });
    console.info(
      JSON.stringify({
        event: "source_repair_completed",
        season,
        gw,
        repairedPicks,
      }),
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
