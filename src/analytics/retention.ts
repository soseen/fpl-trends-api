import "dotenv/config";
import { fileURLToPath } from "node:url";
import { prisma } from "../database/client.js";

// Working facts are disposable only after every historical GW has a finalized
// publication with replay input. Keep this opt-in until the first archive audit.
export const pruneWorkingFacts = async (apply = false): Promise<number> =>
  prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout='30s'");
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout='1s'");
      const [state] = await tx.$queryRaw<
        Array<{ season: string; gw: number; safe: boolean }>
      >`
 WITH state AS (SELECT (SELECT value FROM app_metadata WHERE key='current_season') AS season,(SELECT MAX(id) FROM events) AS gw)
 SELECT s.*, (SELECT value FROM app_metadata WHERE key='manager_sample_gw_finalized')='1'
 AND (SELECT value::int FROM app_metadata WHERE key='manager_sample_gw')=s.gw
 AND (SELECT COUNT(*) FROM analytics_publications p JOIN analytics_benchmarks b ON b.id=p.benchmark_id
  WHERE p.season=s.season AND p.gw<=s.gw AND b.source_payload IS NOT NULL AND (b.payload->>'finalized')::boolean)=s.gw AS safe FROM state s`;
      if (!state?.safe)
        throw new Error(
          "Source retention withheld: all gameweeks must have finalized replay archives and the latest sample must be complete",
        );
      const candidates = await tx.$queryRaw<Array<{ entry_id: number }>>`
 SELECT ms.entry_id FROM manager_summary ms
 WHERE NOT EXISTS(SELECT 1 FROM manager_picks mp WHERE mp.entry_id=ms.entry_id AND mp.gw=${state.gw} AND mp.sampled_at_gw=${state.gw})
 AND NOT EXISTS(SELECT 1 FROM analytics_manager_results r WHERE r.season=${state.season} AND r.entry_id=ms.entry_id AND r.created_at>now()-interval '30 days')
 AND NOT EXISTS(SELECT 1 FROM analytics_jobs j WHERE j.season=${state.season} AND j.entry_id=ms.entry_id AND j.status IN ('queued','running'))
 ORDER BY ms.entry_id LIMIT 500 FOR UPDATE OF ms SKIP LOCKED`;
      if (!apply) return candidates.length;
      const ids = candidates.map((c) => c.entry_id);
      if (!ids.length) return 0;
      // Tables with no FK need explicit deletion. History/picks/cumulative cascade.
      await tx.$executeRaw`DELETE FROM manager_pick_elements WHERE entry_id=ANY(${ids}::int[])`;
      await tx.$executeRaw`DELETE FROM manager_transfers WHERE entry_id=ANY(${ids}::int[])`;
      await tx.$executeRaw`DELETE FROM analytics_manager_sources WHERE season=${state.season} AND entry_id=ANY(${ids}::int[])`;
      await tx.$executeRaw`DELETE FROM manager_summary WHERE entry_id=ANY(${ids}::int[])`;
      return ids.length;
    },
    { timeout: 60000 },
  );

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.info(
      JSON.stringify({
        event: "analytics_working_retention",
        applied: process.argv.includes("--apply"),
        batch: await pruneWorkingFacts(process.argv.includes("--apply")),
      }),
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
