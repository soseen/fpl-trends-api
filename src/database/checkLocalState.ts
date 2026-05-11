import "dotenv/config";
import { fileURLToPath } from "node:url";
import { prisma } from "./client.js";

// One-off local-DB readiness check. Prints row counts for every table the
// My Trends endpoints depend on, so it's obvious which backfill (if any)
// still needs to run. Read-only.

const main = async (): Promise<void> => {
  const summary = await prisma.$queryRaw<
    Array<{ stratum: number; rows: bigint; chip_history: bigint }>
  >`
    SELECT stratum,
           COUNT(*)::bigint AS rows,
           COUNT(*) FILTER (WHERE has_chip_history)::bigint AS chip_history
    FROM manager_summary
    GROUP BY stratum ORDER BY stratum
  `;

  const history = await prisma.$queryRaw<
    Array<{ rows: bigint; managers: bigint; gws: bigint }>
  >`
    SELECT COUNT(*)::bigint AS rows,
           COUNT(DISTINCT entry_id)::bigint AS managers,
           COUNT(DISTINCT gw)::bigint AS gws
    FROM manager_history
  `;

  const picks = await prisma.$queryRaw<
    Array<{
      rows: bigint;
      managers: bigint;
      gws: bigint;
      with_captain: bigint;
    }>
  >`
    SELECT COUNT(*)::bigint AS rows,
           COUNT(DISTINCT entry_id)::bigint AS managers,
           COUNT(DISTINCT gw)::bigint AS gws,
           COUNT(*) FILTER (WHERE captain_element IS NOT NULL)::bigint AS with_captain
    FROM manager_picks
  `;

  const pickElements = await prisma.$queryRaw<
    Array<{ rows: bigint; managers: bigint; gws: bigint }>
  >`
    SELECT COUNT(*)::bigint AS rows,
           COUNT(DISTINCT entry_id)::bigint AS managers,
           COUNT(DISTINCT gw)::bigint AS gws
    FROM manager_pick_elements
  `;

  const cumulative = await prisma.$queryRaw<
    Array<{ rows: bigint; managers: bigint; gws: bigint }>
  >`
    SELECT COUNT(*)::bigint AS rows,
           COUNT(DISTINCT entry_id)::bigint AS managers,
           COUNT(DISTINCT gw)::bigint AS gws
    FROM manager_cumulative
  `;

  const captainPicks = await prisma.$queryRaw<
    Array<{ stratum: number; rows: bigint; total_picks: bigint }>
  >`
    SELECT stratum, COUNT(*)::bigint AS rows, SUM(picks)::bigint AS total_picks
    FROM stratum_captain_picks_gw
    GROUP BY stratum ORDER BY stratum
  `;

  const playerExposure = await prisma.$queryRaw<
    Array<{ rank_band: number; rows: bigint; total_sample: bigint | null }>
  >`
    SELECT rank_band, COUNT(*)::bigint AS rows, SUM(sample_size)::bigint AS total_sample
    FROM rank_band_player_exposure_gw
    GROUP BY rank_band ORDER BY rank_band
  `;

  const runningStats = await prisma.$queryRaw<
    Array<{ stratum: number; rows: bigint; total_sample: bigint | null }>
  >`
    SELECT stratum, COUNT(*)::bigint AS rows, SUM(sample_size)::bigint AS total_sample
    FROM stratum_gw_running_stats
    GROUP BY stratum ORDER BY stratum
  `;

  const events = await prisma.$queryRaw<
    Array<{ finished: bigint; max_gw: number | null }>
  >`
    SELECT COUNT(*) FILTER (WHERE finished)::bigint AS finished,
           MAX(id) FILTER (WHERE finished) AS max_gw
    FROM events
  `;

  console.info("\n=== Local DB readiness ===\n");

  console.info("Events:");
  console.info(
    `  finished GWs: ${events[0]?.finished ?? 0n} (latest: ${events[0]?.max_gw ?? "?"})`,
  );

  console.info("\nmanager_summary (sample membership):");
  for (const r of summary) {
    console.info(
      `  stratum ${r.stratum}: ${r.rows} managers (${r.chip_history} with chip history)`,
    );
  }

  console.info("\nmanager_history (per-GW points for the sample):");
  console.info(
    `  ${history[0]?.rows ?? 0n} rows across ${history[0]?.managers ?? 0n} managers, ${history[0]?.gws ?? 0n} distinct GWs`,
  );

  console.info("\nmanager_picks (captain / chip per GW for the sample):");
  console.info(
    `  ${picks[0]?.rows ?? 0n} rows across ${picks[0]?.managers ?? 0n} managers, ${picks[0]?.gws ?? 0n} distinct GWs`,
  );
  console.info(
    `  with captain_element NOT NULL: ${picks[0]?.with_captain ?? 0n}`,
  );

  console.info("\nmanager_pick_elements (full XV cache, user + sample EO):");
  console.info(
    `  ${pickElements[0]?.rows ?? 0n} rows across ${pickElements[0]?.managers ?? 0n} managers, ${pickElements[0]?.gws ?? 0n} distinct GWs`,
  );

  console.info(
    "\nmanager_cumulative (running totals — the comparison hot path):",
  );
  console.info(
    `  ${cumulative[0]?.rows ?? 0n} rows across ${cumulative[0]?.managers ?? 0n} managers, ${cumulative[0]?.gws ?? 0n} distinct GWs`,
  );

  console.info("\nstratum_captain_picks_gw (captain-rate read path):");
  if (captainPicks.length === 0) {
    console.info(
      "  EMPTY — derived from manager_picks; sparse picks ⇒ empty here.",
    );
  } else {
    for (const r of captainPicks) {
      console.info(
        `  stratum ${r.stratum}: ${r.rows} buckets, ${r.total_picks} picks total`,
      );
    }
  }

  console.info("\nrank_band_player_exposure_gw (team-impact EO read path):");
  if (playerExposure.length === 0) {
    console.info(
      "  EMPTY - derived from manager_pick_elements; EO falls back to global ownership/captain data.",
    );
  } else {
    for (const r of playerExposure) {
      console.info(
        `  band ${r.rank_band}: ${r.rows} buckets, ${r.total_sample ?? 0n} sample-manager-GW pairs`,
      );
    }
  }

  console.info(
    "\nstratum_gw_running_stats (comparison endpoint pre-aggregate):",
  );
  if (runningStats.length === 0) {
    console.info(
      "  EMPTY — run `npm run rebuild-manager-read-models` after schema migration.",
    );
  } else {
    for (const r of runningStats) {
      console.info(
        `  stratum ${r.stratum}: ${r.rows} GW buckets, ${r.total_sample ?? 0n} sample-manager-GW pairs`,
      );
    }
  }

  console.info("\n=== Diagnosis ===");
  const picksRows = Number(picks[0]?.rows ?? 0n);
  const cumRows = Number(cumulative[0]?.rows ?? 0n);
  const captainBuckets = captainPicks.reduce(
    (acc, r) => acc + Number(r.rows),
    0,
  );
  const exposureBuckets = playerExposure.reduce(
    (acc, r) => acc + Number(r.rows),
    0,
  );

  if (cumRows === 0) {
    console.info(
      "  ❌ manager_cumulative empty — run `npm run backfill-cumulative`.",
    );
  } else {
    console.info("  ✅ manager_cumulative populated.");
  }

  if (picksRows === 0) {
    console.info(
      "  ❌ manager_picks empty — run `npm run populate-managers` (or `backfill-picks` for historic depth).",
    );
  } else if (picksRows < Number(history[0]?.rows ?? 0n) / 2) {
    console.info(
      "  ⚠️  manager_picks sparse vs. manager_history — run `npm run backfill-picks` to fill historic GWs (or accept empty captain stats).",
    );
  } else {
    console.info("  ✅ manager_picks reasonably covered.");
  }

  const sparseChipStrata = summary.filter(
    (r) => Number(r.chip_history) < Number(r.rows) * 0.5,
  );
  if (sparseChipStrata.length > 0) {
    console.info(
      "  WARNING chip-history coverage is sparse - re-run `populate-managers` after a cursor-version repair or run `backfill-manager-chips` followed by cumulative/read-model rebuilds.",
    );
  } else {
    console.info("  OK chip-history coverage looks healthy.");
  }

  if (captainBuckets === 0) {
    console.info(
      "  ❌ stratum_captain_picks_gw empty — derived from manager_picks; populate that first then re-run `npm run rebuild-manager-read-models`.",
    );
  } else {
    console.info("  ✅ stratum_captain_picks_gw populated.");
  }

  if (exposureBuckets === 0) {
    console.info(
      "  rank_band_player_exposure_gw empty - run `npm run backfill-comparison-picks` or `npm run rebuild-manager-read-models` after sample full-XV picks exist.",
    );
  } else {
    console.info("  rank_band_player_exposure_gw populated.");
  }

  const runningRows = runningStats.reduce((acc, r) => acc + Number(r.rows), 0);
  if (runningRows === 0) {
    console.info(
      "  ❌ stratum_gw_running_stats empty — run `npm run rebuild-manager-read-models` after manager_cumulative is populated.",
    );
  } else {
    console.info("  ✅ stratum_gw_running_stats populated.");
  }

  console.info("");
};

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (err) {
    console.error("[checkLocalState] Failed:", (err as Error).message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
