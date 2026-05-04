import "dotenv/config";
import { fileURLToPath } from "node:url";
import { prisma } from "./client.js";
import { rebuildStratumGwRunningStats } from "./populateManagers.js";

// One-shot rebuild of stratum_gw_running_stats from manager_cumulative.
// Steady-state maintenance happens at the end of every populateManagers
// run via the same `rebuildStratumGwRunningStats` helper — this script is
// just a way to trigger that rebuild out-of-band, e.g. immediately after
// applying the schema migration so the read paths in
// getManagerComparison.sampleStratumAggregates have a populated table to
// read from before the next 15-minute populate cron tick.
//
// Idempotent (TRUNCATE+INSERT inside a transaction). Safe to run while
// `populate-managers` is mid-tick — both paths write the same buckets and
// can't disagree.
const main = async (): Promise<void> => {
  console.info("[backfillStratumGwRunningStats] Starting rebuild…");
  const startedAt = Date.now();

  await rebuildStratumGwRunningStats();

  const elapsedMs = Date.now() - startedAt;

  const counts = await prisma.$queryRaw<
    Array<{ stratum: number; rows: bigint; total_sample: bigint | null }>
  >`
    SELECT stratum, COUNT(*)::bigint AS rows, SUM(sample_size)::bigint AS total_sample
    FROM stratum_gw_running_stats
    GROUP BY stratum
    ORDER BY stratum
  `;

  console.info(
    `[backfillStratumGwRunningStats] Done in ${elapsedMs}ms. Per-stratum row counts:`,
  );
  for (const row of counts) {
    console.info(
      `  stratum ${row.stratum}: ${row.rows} GW buckets, ${row.total_sample ?? 0n} sample-manager-GW pairs`,
    );
  }
};

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (err) {
    console.error(
      "[backfillStratumGwRunningStats] Failed:",
      (err as Error).message,
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
