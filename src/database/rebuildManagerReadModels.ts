import "dotenv/config";
import { fileURLToPath } from "node:url";
import { prisma } from "./client.js";
import { rebuildManagerReadModels } from "./populateManagers.js";

const main = async (): Promise<void> => {
  const rangeBucketArg = process.argv.find((arg) =>
    arg.startsWith("--range-buckets="),
  );
  const rangeBuckets =
    rangeBucketArg?.split("=")[1] === "latest" ? "latest" : "all";
  const transferAverageArg = process.argv.find((arg) =>
    arg.startsWith("--transfer-averages="),
  );
  const transferAverages =
    transferAverageArg?.split("=")[1] === "skip" ? "skip" : "latest";

  console.info("[rebuildManagerReadModels] Starting...");
  const startedAt = Date.now();

  await rebuildManagerReadModels({ rangeBuckets, transferAverages });

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  const counts = await prisma.$queryRaw<
    Array<{ table_name: string; rows: bigint }>
  >`
    SELECT 'stratum_captain_picks_gw' AS table_name, COUNT(*)::bigint AS rows
    FROM stratum_captain_picks_gw
    UNION ALL
    SELECT 'rank_band_player_exposure_gw', COUNT(*)::bigint
    FROM rank_band_player_exposure_gw
    UNION ALL
    SELECT 'stratum_gw_running_stats', COUNT(*)::bigint
    FROM stratum_gw_running_stats
    UNION ALL
    SELECT 'manager_range_score_buckets', COUNT(*)::bigint
    FROM manager_range_score_buckets
    UNION ALL
    SELECT 'stratum_range_xfer_avg', COUNT(*)::bigint
    FROM stratum_range_xfer_avg
    ORDER BY table_name
  `;

  console.info(`[rebuildManagerReadModels] Done in ${elapsedSec}s.`);
  for (const row of counts) {
    console.info(`  ${row.table_name}: ${row.rows} rows`);
  }
};

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (err) {
    console.error("[rebuildManagerReadModels] Failed:", (err as Error).message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
