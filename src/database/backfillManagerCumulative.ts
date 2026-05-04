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
// Captain bonus: LEFT JOINs manager_picks ⨝ history per (entry_id, gw) to
// pull the GW points scored by the captained player times (multiplier − 1).
// LEFT JOIN means GWs without picks contribute 0 — captain bonus
// converges to correctness as backfillPicks fills in historical picks (or
// as the populate cron's inline picks ingestion catches up the latest GW).
//
// No lock conflict with populateManagers — both this script and the cron's
// per-entry rebuild upsert by (entry_id, gw) and compute the same value
// from the same source rows, so last-writer-wins is identical regardless.

// Mirror of CHIP_HALVES_BOUNDARY in populateManagers.ts. Kept inline here
// rather than imported because the populate module pulls in HTTP / FPL
// dependencies the backfill doesn't need at startup.
const CHIP_HALVES_BOUNDARY = 19;

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
      INSERT INTO manager_cumulative
        (entry_id, gw, cumulative_points, cumulative_transfers,
         cumulative_hits_cost, cumulative_bench, cumulative_captain_bonus,
         gws_played,
         chip_wildcard_h1, chip_wildcard_h2,
         chip_freehit_h1,  chip_freehit_h2,
         chip_bboost_h1,   chip_bboost_h2,
         has_transfers, has_hits, has_bench,
         stratum)
      SELECT
        base.entry_id,
        base.gw,
        (SUM(base.points)                            OVER w)::int AS cumulative_points,
        (SUM(COALESCE(base.event_transfers,      0)) OVER w)::int AS cumulative_transfers,
        (SUM(COALESCE(base.event_transfers_cost, 0)) OVER w)::int AS cumulative_hits_cost,
        (SUM(COALESCE(base.points_on_bench,      0)) OVER w)::int AS cumulative_bench,
        (SUM(base.captain_bonus)                     OVER w)::int AS cumulative_captain_bonus,
        (COUNT(*)                                    OVER w)::int AS gws_played,
        -- COALESCE to FALSE: when manager_picks is missing for a (entry, gw),
        -- active_chip is NULL via LEFT JOIN, and (NULL = 'wildcard') is NULL.
        -- For h1 (gw <= 19) the AND with TRUE leaves NULL; BOOL_OR over an
        -- all-NULL partition then returns NULL, which violates the NOT NULL
        -- constraint on the chip columns. Coercing to FALSE pre-aggregate
        -- keeps the read-path semantics correct (no picks => no chip played)
        -- and the column non-null. Mirrors the same fix in
        -- populateManagers.rebuildCumulativeForEntry: the two paths must
        -- write byte-identical rows for any entry.
        BOOL_OR(COALESCE(base.active_chip = 'wildcard' AND base.gw <= ${CHIP_HALVES_BOUNDARY}, false)) OVER w AS chip_wildcard_h1,
        BOOL_OR(COALESCE(base.active_chip = 'wildcard' AND base.gw  > ${CHIP_HALVES_BOUNDARY}, false)) OVER w AS chip_wildcard_h2,
        BOOL_OR(COALESCE(base.active_chip = 'freehit'  AND base.gw <= ${CHIP_HALVES_BOUNDARY}, false)) OVER w AS chip_freehit_h1,
        BOOL_OR(COALESCE(base.active_chip = 'freehit'  AND base.gw  > ${CHIP_HALVES_BOUNDARY}, false)) OVER w AS chip_freehit_h2,
        BOOL_OR(COALESCE(base.active_chip = 'bboost'   AND base.gw <= ${CHIP_HALVES_BOUNDARY}, false)) OVER w AS chip_bboost_h1,
        BOOL_OR(COALESCE(base.active_chip = 'bboost'   AND base.gw  > ${CHIP_HALVES_BOUNDARY}, false)) OVER w AS chip_bboost_h2,
        BOOL_OR(base.event_transfers      IS NOT NULL) OVER w AS has_transfers,
        BOOL_OR(base.event_transfers_cost IS NOT NULL) OVER w AS has_hits,
        BOOL_OR(base.points_on_bench      IS NOT NULL) OVER w AS has_bench,
        base.stratum
      FROM (
        SELECT
          mh.entry_id, mh.gw, mh.points,
          mh.event_transfers, mh.event_transfers_cost, mh.points_on_bench,
          mp.active_chip,
          ms.stratum,
          COALESCE(
            CASE
              WHEN mp.captain_multiplier IS NOT NULL AND mp.captain_multiplier > 1 THEN
                (SELECT SUM(h.total_points)::int
                   FROM history h
                   WHERE h.footballer_id = mp.captain_element AND h.round = mh.gw)
                * (mp.captain_multiplier - 1)
              ELSE 0
            END,
            0
          ) AS captain_bonus
        FROM manager_history mh
        JOIN manager_summary ms ON ms.entry_id = mh.entry_id
        LEFT JOIN manager_picks mp
          ON mp.entry_id = mh.entry_id AND mp.gw = mh.gw
        WHERE mh.entry_id BETWEEN ${lo} AND ${hi}
      ) base
      WINDOW w AS (PARTITION BY base.entry_id ORDER BY base.gw)
      ON CONFLICT (entry_id, gw) DO UPDATE SET
        cumulative_points        = EXCLUDED.cumulative_points,
        cumulative_transfers     = EXCLUDED.cumulative_transfers,
        cumulative_hits_cost     = EXCLUDED.cumulative_hits_cost,
        cumulative_bench         = EXCLUDED.cumulative_bench,
        cumulative_captain_bonus = EXCLUDED.cumulative_captain_bonus,
        gws_played               = EXCLUDED.gws_played,
        chip_wildcard_h1         = EXCLUDED.chip_wildcard_h1,
        chip_wildcard_h2         = EXCLUDED.chip_wildcard_h2,
        chip_freehit_h1          = EXCLUDED.chip_freehit_h1,
        chip_freehit_h2          = EXCLUDED.chip_freehit_h2,
        chip_bboost_h1           = EXCLUDED.chip_bboost_h1,
        chip_bboost_h2           = EXCLUDED.chip_bboost_h2,
        has_transfers            = EXCLUDED.has_transfers,
        has_hits                 = EXCLUDED.has_hits,
        has_bench                = EXCLUDED.has_bench,
        stratum                  = EXCLUDED.stratum
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
