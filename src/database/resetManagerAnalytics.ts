import "dotenv/config";
import { fileURLToPath } from "node:url";
import { prisma } from "./client.js";

const MANAGER_CURSOR_KEYS = [
  "manager_ingest_cursor_a",
  "manager_ingest_cursor_b",
  "manager_ingest_cursor_c",
  "manager_sample_gw",
  "manager_sample_gw_cleaned",
  "manager_sample_gw_finalized",
  "manager_walk_cursor_version",
] as const;

export const resetManagerAnalytics = async (): Promise<void> => {
  console.info(
    "[resetManagerAnalytics] Truncating manager analytics tables...",
  );

  await prisma.$transaction([
    prisma.$executeRawUnsafe(`
      TRUNCATE
        manager_pick_elements,
        manager_transfers,
        manager_cumulative,
        manager_history,
        manager_picks,
        manager_summary,
        rank_band_player_exposure_gw,
        stratum_captain_picks_gw,
        stratum_gw_running_stats,
        manager_range_score_buckets
      RESTART IDENTITY
    `),
    prisma.$executeRawUnsafe(
      `
      DELETE FROM app_metadata
      WHERE key = ANY($1::text[])
      `,
      [...MANAGER_CURSOR_KEYS],
    ),
  ]);

  console.info(
    "[resetManagerAnalytics] Done. Run `npm run populate-managers` until the walks complete.",
  );
};

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await resetManagerAnalytics();
  } catch (err) {
    console.error("[resetManagerAnalytics] Failed:", (err as Error).message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
