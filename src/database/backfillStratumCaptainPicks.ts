import "dotenv/config";
import { fileURLToPath } from "node:url";
import { prisma } from "./client.js";
import { rebuildStratumCaptainPicks } from "./populateManagers.js";

// One-shot rebuild of stratum_captain_picks_gw from manager_picks ⨝
// manager_summary. Steady-state maintenance happens at the end of every
// populateManagers run via the same `rebuildStratumCaptainPicks` helper —
// this script is just a way to trigger that rebuild out-of-band, e.g.
// immediately after applying the schema migration so the read paths in
// getTeamImpact and getManagerComparison have a populated table to read
// from before the next 30-minute populate cron tick.
//
// Idempotent (TRUNCATE+INSERT inside a transaction). Safe to run while
// `populate-managers` is mid-tick — both paths write the same buckets and
// can't disagree.
const main = async (): Promise<void> => {
  console.info("[backfillStratumCaptainPicks] Starting rebuild…");
  const startedAt = Date.now();

  await rebuildStratumCaptainPicks();

  const elapsedMs = Date.now() - startedAt;

  const counts = await prisma.$queryRaw<
    Array<{ stratum: number; rows: bigint; total_picks: bigint }>
  >`
    SELECT stratum, COUNT(*)::bigint AS rows, SUM(picks)::bigint AS total_picks
    FROM stratum_captain_picks_gw
    GROUP BY stratum
    ORDER BY stratum
  `;

  console.info(
    `[backfillStratumCaptainPicks] Done in ${elapsedMs}ms. Per-stratum row counts:`,
  );
  for (const row of counts) {
    console.info(
      `  stratum ${row.stratum}: ${row.rows} buckets, ${row.total_picks} picks total`,
    );
  }
};

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (err) {
    console.error(
      "[backfillStratumCaptainPicks] Failed:",
      (err as Error).message,
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
