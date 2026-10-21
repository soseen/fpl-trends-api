import "dotenv/config";
import { fileURLToPath } from "node:url";
import { prisma } from "./client.js";
import { rebuildComparisonRangeStats } from "./populateManagers.js";

// One-shot full rebuild for all available (start_gw, end_gw) ranges. Run
// after backfill-cumulative when deploying the comparison_range_stats schema.
// Steady-state populate jobs only refresh ranges ending at the current GW.
const main = async (): Promise<void> => {
  const latestOnly = process.argv.includes("--latest");
  const latest = latestOnly
    ? await prisma.manager_cumulative.aggregate({ _max: { gw: true } })
    : null;
  const latestGw = latest?._max.gw ?? 0;
  console.info(
    `[backfillComparisonRangeStats] Starting ${latestOnly ? `GW${latestGw} rebuild` : "full rebuild"}...`,
  );
  const startedAt = Date.now();

  await rebuildComparisonRangeStats(
    latestOnly && latestGw >= 1 ? { endGwOnly: latestGw } : undefined,
  );

  const rows = await prisma.$queryRaw<
    Array<{ stratum: number; ranges: bigint; latest: Date | null }>
  >`
    SELECT stratum,
           COUNT(*)::bigint AS ranges,
           MAX(last_rebuilt) AS latest
    FROM comparison_range_stats
    GROUP BY stratum
    ORDER BY stratum
  `;
  console.info(
    `[backfillComparisonRangeStats] Done in ${Math.round((Date.now() - startedAt) / 1000)}s.`,
  );
  for (const row of rows) {
    console.info(
      `  stratum ${row.stratum}: ${row.ranges} ranges, latest ${row.latest?.toISOString() ?? "n/a"}`,
    );
  }
};

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (err) {
    console.error(
      "[backfillComparisonRangeStats] Failed:",
      (err as Error).message,
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
