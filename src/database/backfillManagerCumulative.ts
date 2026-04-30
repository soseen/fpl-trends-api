import "dotenv/config";
import { fileURLToPath } from "node:url";
import { prisma } from "./client.js";

// One-time backfill of manager_cumulative from manager_history. Idempotent
// (ON CONFLICT … DO UPDATE) so safe to interrupt and rerun. After this
// lands, populateManagers.processEntry maintains the table on every visit;
// this script only matters for the initial bootstrap of the production
// table from the existing ~625k × ~30 GW manager_history sample.
//
// Strategy: a single SQL with SUM(...) OVER (PARTITION BY entry_id ORDER BY
// gw), batched by entry_id ranges to keep transaction size bounded. The
// window function lives entirely in PostgreSQL so the working set never
// crosses the wire.
//
// No lock conflict with populateManagers — both this script and the cron's
// per-entry rebuild upsert by (entry_id, gw) and compute the same value
// from the same source rows, so last-writer-wins is identical regardless.

const BATCH_SIZE = 10_000;

const backfill = async (): Promise<void> => {
  const bounds = await prisma.$queryRaw<
    Array<{ min: number | null; max: number | null }>
  >`
    SELECT MIN(entry_id)::int AS min, MAX(entry_id)::int AS max
    FROM manager_summary
  `;
  const min = bounds[0]?.min ?? null;
  const max = bounds[0]?.max ?? null;
  if (min === null || max === null) {
    console.info(
      "[backfillCumulative] No managers in manager_summary — nothing to do.",
    );
    return;
  }

  console.info(
    `[backfillCumulative] entry_id range ${min}..${max} (batch size ${BATCH_SIZE})`,
  );

  const startedAt = Date.now();
  let totalRows = 0;
  let batchCount = 0;

  for (let lo = min; lo <= max; lo += BATCH_SIZE) {
    const hi = Math.min(lo + BATCH_SIZE - 1, max);
    const rowCount = await prisma.$executeRaw`
      INSERT INTO manager_cumulative (entry_id, gw, cumulative_points, stratum, rejected_reason)
      SELECT
        mh.entry_id,
        mh.gw,
        SUM(mh.points) OVER (PARTITION BY mh.entry_id ORDER BY mh.gw)::int AS cumulative_points,
        ms.stratum,
        ms.rejected_reason
      FROM manager_history mh
      JOIN manager_summary ms ON ms.entry_id = mh.entry_id
      WHERE mh.entry_id BETWEEN ${lo} AND ${hi}
      ON CONFLICT (entry_id, gw) DO UPDATE SET
        cumulative_points = EXCLUDED.cumulative_points,
        stratum           = EXCLUDED.stratum,
        rejected_reason   = EXCLUDED.rejected_reason
    `;
    totalRows += rowCount;
    batchCount += 1;
    console.info(
      `[backfillCumulative] entries ${lo}..${hi} → ${rowCount} rows (running total ${totalRows})`,
    );
  }

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  console.info(
    `[backfillCumulative] Done. ${batchCount} batches, ${totalRows} rows total, ${elapsedSec}s elapsed.`,
  );
};

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await backfill();
  } catch (err) {
    console.error("[backfillCumulative] Failed:", (err as Error).message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
