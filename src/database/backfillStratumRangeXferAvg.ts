import "dotenv/config";
import { fileURLToPath } from "node:url";
import { prisma } from "./client.js";
import { rebuildStratumRangeXferAvg } from "./populateManagers.js";

// One-shot rebuild of stratum_range_xfer_avg for every (start_gw, end_gw)
// pair. Use after deploying the migration to populate older ranges that
// the steady-state cron skips (cron only refreshes end_gw=currentGw).
//
// Idempotent: TRUNCATEs before INSERTing. Safe to interrupt — partial rows
// are simply overwritten on the next run.
//
// Runtime: ~10-30 min on prod (1444 INSERTs at ~0.5-1s each, depending on
// transfer-history coverage). Run OOB; populateManagers cron continues
// updating the current end_gw column without colliding (different rows).
const main = async (): Promise<void> => {
  console.info("[backfillStratumRangeXferAvg] Starting full rebuild…");
  const startedAt = Date.now();

  await rebuildStratumRangeXferAvg();

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  const counts = await prisma.$queryRaw<
    Array<{
      stratum: number;
      rows: bigint;
      total_managers_with_xfers: bigint | null;
    }>
  >`
    SELECT stratum,
           COUNT(*)::bigint AS rows,
           SUM(managers_with_xfers)::bigint AS total_managers_with_xfers
    FROM stratum_range_xfer_avg
    GROUP BY stratum
    ORDER BY stratum
  `;

  console.info(
    `[backfillStratumRangeXferAvg] Done in ${elapsedSec}s. Per-stratum row counts:`,
  );
  for (const row of counts) {
    console.info(
      `  stratum ${row.stratum}: ${row.rows} (start_gw, end_gw) pairs, ${row.total_managers_with_xfers ?? 0n} contributing manager-range pairs`,
    );
  }
};

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (err) {
    console.error(
      "[backfillStratumRangeXferAvg] Failed:",
      (err as Error).message,
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
