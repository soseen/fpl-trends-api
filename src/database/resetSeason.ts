/**
 * Manual season reset script.
 *
 * Usage:  npm run reset-season
 *
 * Wipes ALL game data from the database (footballers, history, fixtures,
 * teams, team_history, events) and clears cached JSON files.
 * The season identifier is also cleared so the next populate run
 * will re-detect and store the current season.
 *
 * Use this as a fallback if automatic season detection doesn't trigger,
 * or to force a clean slate at any time.
 */

import "dotenv/config";
import { wipeAllSeasonData } from "./seasonManager.js";
import { prisma } from "./client.js";

async function main() {
  console.info("\n⚠️  MANUAL SEASON RESET\n");
  console.info("This will delete ALL game data from the database.");
  console.info("Run `npm run populate` afterwards to re-fetch fresh data.\n");

  await wipeAllSeasonData();

  // Also clear the stored season so it gets re-detected on next populate
  try {
    await prisma.$executeRaw`
      DELETE FROM app_metadata WHERE key = 'current_season'
    `;
    console.info("   ✓ Season identifier cleared");
  } catch {
    // Key might not exist yet, that's fine
  }

  console.info(
    "\n✅ Season reset complete. Run `npm run populate` to re-fetch data.\n",
  );
  process.exit(0);
}

main().catch((error) => {
  console.error("❌ Season reset failed:", error);
  process.exit(1);
});
