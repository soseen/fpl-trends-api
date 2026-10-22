// Legacy read-model builders retained for historical parity checks and incident recovery.
// The API and recurring ingestion use published analytics instead.
import { prisma } from "./client.js";
import { rankedPopulationSql } from "../managers/rankedPopulation.js";
import { rankBandSqlCase } from "../managers/rankBands.js";
const getCurrentSampleGameweek = async () => ({
  gw: (await prisma.events.aggregate({ _max: { id: true } }))._max.id ?? 0,
});
const CHIP_HALVES_BOUNDARY = 19;

// Per-entry cumulative rebuild: DELETE all this entry's manager_cumulative
// rows then INSERT one fresh row per (entry_id, gw) where manager_history
// has a row. Keeping cumulative as a strict mirror of history (no synthetic
// anchor rows, no rows for non-participated GWs) is what lets the range
// query use DISTINCT ON to find the latest in-range row per entry — see
// getRangeRank.ts.
//
// Re-querying manager_history rather than computing from `history.current`
// is intentional: if FPL ever returns a smaller payload than what we've
// already persisted (we never delete history rows), the DB query is
// canonical. Stratum is denormalised onto every row so the read path
// needs no manager_summary join.
//
// Captain bonus joins manager_picks for the entry and the footballers'
// `history` table for the captained player's GW points. For GWs where
// picks haven't been ingested yet (the typical case before backfillPicks
// has run for this entry's earlier GWs), the LEFT JOIN yields NULL and
// the contribution is 0 — the comparison endpoint's sample average is
// best-effort and converges as picks are filled in over subsequent
// processEntry visits.
export const rebuildCumulativeForEntry = async (
  entryId: number,
  stratum: 1 | 2 | 3,
): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`DELETE FROM manager_cumulative WHERE entry_id = ${entryId}`;
    await tx.$executeRawUnsafe(
      `
      INSERT INTO manager_cumulative
        (entry_id, gw, cumulative_points, cumulative_transfers,
         cumulative_hits_cost, cumulative_bench, cumulative_captain_bonus,
         gws_played,
         chip_wildcard_h1, chip_wildcard_h2,
         chip_freehit_h1,  chip_freehit_h2,
         chip_bboost_h1,   chip_bboost_h2,
         has_transfers, has_hits, has_bench,
         picks_count_cum,
         stratum)
      SELECT
        base.entry_id, base.gw,
        (SUM(base.points)                            OVER w)::int AS cumulative_points,
        (SUM(COALESCE(base.event_transfers,      0)) OVER w)::int AS cumulative_transfers,
        (SUM(COALESCE(base.event_transfers_cost, 0)) OVER w)::int AS cumulative_hits_cost,
        (SUM(COALESCE(base.points_on_bench,      0)) OVER w)::int AS cumulative_bench,
        (SUM(base.captain_bonus)                     OVER w)::int AS cumulative_captain_bonus,
        (COUNT(*)                                    OVER w)::int AS gws_played,
        -- active_chip comes from entry history. Null means no chip that GW.
        BOOL_OR(COALESCE(base.active_chip = 'wildcard' AND base.gw <= $3, false)) OVER w AS chip_wildcard_h1,
        BOOL_OR(COALESCE(base.active_chip = 'wildcard' AND base.gw  > $3, false)) OVER w AS chip_wildcard_h2,
        BOOL_OR(COALESCE(base.active_chip = 'freehit'  AND base.gw <= $3, false)) OVER w AS chip_freehit_h1,
        BOOL_OR(COALESCE(base.active_chip = 'freehit'  AND base.gw  > $3, false)) OVER w AS chip_freehit_h2,
        BOOL_OR(COALESCE(base.active_chip = 'bboost'   AND base.gw <= $3, false)) OVER w AS chip_bboost_h1,
        BOOL_OR(COALESCE(base.active_chip = 'bboost'   AND base.gw  > $3, false)) OVER w AS chip_bboost_h2,
        BOOL_OR(base.event_transfers      IS NOT NULL) OVER w AS has_transfers,
        BOOL_OR(base.event_transfers_cost IS NOT NULL) OVER w AS has_hits,
        BOOL_OR(base.points_on_bench      IS NOT NULL) OVER w AS has_bench,
        (SUM(base.has_picks)                         OVER w)::int AS picks_count_cum,
        $2
      FROM (
        SELECT
          mh.entry_id, mh.gw, mh.points,
          mh.event_transfers, mh.event_transfers_cost, mh.points_on_bench,
          mh.active_chip,
          CASE WHEN mp.gw IS NOT NULL THEN 1 ELSE 0 END AS has_picks,
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
        LEFT JOIN manager_picks mp
          ON mp.entry_id = mh.entry_id AND mp.gw = mh.gw
        WHERE mh.entry_id = $1
      ) base
      WINDOW w AS (PARTITION BY base.entry_id ORDER BY base.gw)
      ORDER BY base.gw
      `,
      entryId,
      stratum,
      CHIP_HALVES_BOUNDARY,
    );
  });
};

// Rebuild the (stratum, gw, captain_element, captain_multiplier) aggregate
// table used by getTeamImpact.fetchCaptainRatesInStratum and
// getManagerComparison.sampleMostCaptained. Single TRUNCATE+INSERT inside
// a transaction so readers always see a consistent snapshot — no partial
// state where some captains/GWs are missing.
//
// Exported so rebuildManagerReadModels can call this out-of-band (e.g.
// immediately after deploying the schema, before the next populate cron
// tick).
export const rebuildStratumCaptainPicks = async (): Promise<void> => {
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`TRUNCATE stratum_captain_picks_gw`),
    prisma.$executeRawUnsafe(`
      INSERT INTO stratum_captain_picks_gw
        (stratum, gw, captain_element, captain_multiplier, picks, last_rebuilt)
      SELECT
        mp.sample_stratum,
        mp.gw,
        mp.captain_element,
        mp.captain_multiplier,
        COUNT(*)::int AS picks,
        NOW()         AS last_rebuilt
      FROM manager_picks mp
      WHERE mp.captain_element IS NOT NULL
        AND mp.captain_multiplier IS NOT NULL
        AND mp.sampled_at_gw = mp.gw
        AND mp.sample_stratum BETWEEN 1 AND 3
      GROUP BY mp.sample_stratum, mp.gw, mp.captain_element, mp.captain_multiplier
    `),
  ]);
};

// Rebuild LiveFPL-style player exposure by causal pre-GW rank band. Managers
// are selected from the post-GW standings with deliberately unequal sampling
// rates, so raw counts would over-represent managers who moved into the top
// 100k. Inverse-probability weights reconstruct the pre-GW band's population;
// the stored sample_size is Kish effective N so request-time quality gates
// still reflect statistical support rather than weighted population size.
export const rebuildRankBandPlayerExposure = async ({
  gwOnly,
}: { gwOnly?: number } = {}): Promise<void> => {
  const previousRankBand = rankBandSqlCase("mh_previous.overall_rank");
  const pickGameweekFilter = gwOnly === undefined ? "" : " AND mpe.gw = $1";
  const eventGameweekFilter = gwOnly === undefined ? "" : " AND e.id = $1";
  const parameters = gwOnly === undefined ? [] : [gwOnly];
  await prisma.$transaction([
    // Readers retain the previous committed snapshot during this long rebuild.
    // TRUNCATE would hold an exclusive table lock until the aggregate completes.
    prisma.$executeRawUnsafe(
      `DELETE FROM rank_band_player_exposure_gw${gwOnly === undefined ? "" : " WHERE gw = $1"}`,
      ...parameters,
    ),
    prisma.$executeRawUnsafe(
      `
      INSERT INTO rank_band_player_exposure_gw
        (rank_band, gw, element_id, sample_size, squad_picks, active_picks,
         effective_multiplier_sum, last_rebuilt)
      WITH same_gw_sampled_pick_rows AS (
        SELECT
          mpe.gw,
          mpe.entry_id,
          mpe.element_id,
          mpe.multiplier,
          mp.sample_stratum
        FROM manager_pick_elements mpe
        JOIN manager_picks mp
          ON mp.entry_id = mpe.entry_id
         AND mp.gw = mpe.gw
         AND mp.sampled_at_gw = mpe.gw
         AND mp.sample_stratum BETWEEN 1 AND 3
        WHERE mpe.gw > 1${pickGameweekFilter}
      ),
      sample_stratum_sizes AS (
        SELECT
          gw,
          sample_stratum,
          COUNT(DISTINCT entry_id)::numeric AS sample_size
        FROM same_gw_sampled_pick_rows
        GROUP BY gw, sample_stratum
      ),
      sample_stratum_population_grid AS (
        SELECT
          e.id AS gw,
          source.sample_stratum,
          CASE source.sample_stratum
            WHEN 1 THEN LEAST(${rankedPopulationSql("e")}, 10000)::numeric
            WHEN 2 THEN GREATEST(LEAST(${rankedPopulationSql("e")}, 100000) - 10000, 0)::numeric
            ELSE GREATEST(${rankedPopulationSql("e")} - 100000, 0)::numeric
          END AS population
        FROM events e
        CROSS JOIN (VALUES (1), (2), (3)) AS source(sample_stratum)
        WHERE e.id > 1${eventGameweekFilter}
      ),
      sample_coverage AS (
        SELECT
          p.gw,
          BOOL_AND(
            p.population = 0 OR COALESCE(s.sample_size, 0) > 0
          ) AS complete
        FROM sample_stratum_population_grid p
        LEFT JOIN sample_stratum_sizes s
          ON s.gw = p.gw
         AND s.sample_stratum = p.sample_stratum
        GROUP BY p.gw
      ),
      sample_weights AS (
        SELECT
          p.gw,
          p.sample_stratum,
          p.population / s.sample_size AS sample_weight
        FROM sample_stratum_population_grid p
        JOIN sample_stratum_sizes s
          ON s.gw = p.gw
         AND s.sample_stratum = p.sample_stratum
        JOIN sample_coverage c ON c.gw = p.gw AND c.complete
        WHERE p.population > 0
      ),
      causal_pick_rows AS (
        SELECT
          ${previousRankBand} AS rank_band,
          sampled.gw,
          sampled.entry_id,
          sampled.element_id,
          sampled.multiplier,
          weight.sample_weight
        FROM same_gw_sampled_pick_rows sampled
        JOIN manager_history mh_previous
          ON mh_previous.entry_id = sampled.entry_id
         AND mh_previous.gw = sampled.gw - 1
        JOIN sample_weights weight
          ON weight.gw = sampled.gw
         AND weight.sample_stratum = sampled.sample_stratum
        WHERE mh_previous.overall_rank > 0
      ),
      weighted_manager_rows AS (
        SELECT DISTINCT
          rank_band,
          gw,
          entry_id,
          sample_weight
        FROM causal_pick_rows
        WHERE rank_band BETWEEN 1 AND 9
      ),
      samples AS (
        SELECT
          rank_band,
          gw,
          GREATEST(
            ROUND(
              POWER(SUM(sample_weight), 2)
                / NULLIF(SUM(sample_weight * sample_weight), 0)
            )::int,
            1
          ) AS sample_size,
          SUM(sample_weight)::numeric AS weighted_population
        FROM weighted_manager_rows
        GROUP BY rank_band, gw
      ),
      player_exposure AS (
        SELECT
          rank_band,
          gw,
          element_id,
          SUM(sample_weight)::numeric AS weighted_squad_picks,
          COALESCE(
            SUM(sample_weight) FILTER (WHERE multiplier > 0),
            0
          )::numeric AS weighted_active_picks,
          COALESCE(
            SUM(multiplier * sample_weight),
            0
          )::numeric AS weighted_multiplier_sum
        FROM causal_pick_rows
        WHERE rank_band BETWEEN 1 AND 9
        GROUP BY rank_band, gw, element_id
      ),
      gw1_pick_rows AS (
        SELECT
          mpe.entry_id,
          mpe.element_id,
          mpe.multiplier,
          CASE
            WHEN mh_end.overall_rank <= 10000 THEN 1
            WHEN mh_end.overall_rank <= 100000 THEN 2
            ELSE 3
          END AS outcome_stratum
        FROM manager_pick_elements mpe
        JOIN manager_history mh_end
          ON mh_end.entry_id = mpe.entry_id
         AND mh_end.gw = mpe.gw
        WHERE mpe.gw = 1${pickGameweekFilter}
          AND mh_end.overall_rank > 0
      ),
      gw1_samples AS (
        SELECT outcome_stratum, COUNT(DISTINCT entry_id)::int AS sample_size
        FROM gw1_pick_rows
        GROUP BY outcome_stratum
      ),
      gw1_population AS (
        SELECT 1 AS outcome_stratum,
               LEAST(ranked_count, 10000)::numeric AS population
        FROM events WHERE id = 1
        UNION ALL
        SELECT 2,
               GREATEST(LEAST(ranked_count, 100000) - 10000, 0)::numeric
        FROM events WHERE id = 1
        UNION ALL
        SELECT 3,
               GREATEST(ranked_count - 100000, 0)::numeric
        FROM events WHERE id = 1
      ),
      gw1_covered_population AS (
        SELECT SUM(p.population)::numeric AS population
        FROM gw1_population p
        JOIN gw1_samples s USING (outcome_stratum)
        WHERE s.sample_size > 0 AND p.population > 0
      ),
      gw1_player_exposure AS (
        SELECT
          outcome_stratum,
          element_id,
          COUNT(*)::int AS squad_picks,
          COUNT(*) FILTER (WHERE multiplier > 0)::int AS active_picks,
          COALESCE(SUM(multiplier), 0)::int AS effective_multiplier_sum
        FROM gw1_pick_rows
        GROUP BY outcome_stratum, element_id
      ),
      gw1_weighted AS (
        SELECT
          0::int AS rank_band,
          1::int AS gw,
          pe.element_id,
          1000000::int AS sample_size,
          ROUND(
            SUM(pe.squad_picks::numeric / s.sample_size * p.population)
              / cp.population * 1000000
          )::int AS squad_picks,
          ROUND(
            SUM(pe.active_picks::numeric / s.sample_size * p.population)
              / cp.population * 1000000
          )::int AS active_picks,
          ROUND(
            SUM(pe.effective_multiplier_sum::numeric / s.sample_size * p.population)
              / cp.population * 1000000
          )::int AS effective_multiplier_sum
        FROM gw1_player_exposure pe
        JOIN gw1_samples s USING (outcome_stratum)
        JOIN gw1_population p USING (outcome_stratum)
        CROSS JOIN gw1_covered_population cp
        WHERE cp.population > 0
        GROUP BY pe.element_id, cp.population
      )
      SELECT
        pe.rank_band,
        pe.gw,
        pe.element_id,
        s.sample_size,
        ROUND(
          pe.weighted_squad_picks / s.weighted_population * s.sample_size
        )::int AS squad_picks,
        ROUND(
          pe.weighted_active_picks / s.weighted_population * s.sample_size
        )::int AS active_picks,
        ROUND(
          pe.weighted_multiplier_sum / s.weighted_population * s.sample_size
        )::int AS effective_multiplier_sum,
        NOW() AS last_rebuilt
      FROM player_exposure pe
      JOIN samples s ON s.rank_band = pe.rank_band AND s.gw = pe.gw
      UNION ALL
      SELECT
        rank_band,
        gw,
        element_id,
        sample_size,
        squad_picks,
        active_picks,
        effective_multiplier_sum,
        NOW() AS last_rebuilt
      FROM gw1_weighted
    `,
      ...parameters,
    ),
  ]);
};

// Rebuild the (stratum, gw) running-stats table used by
// getManagerComparison.sampleStratumAggregates. Single TRUNCATE+INSERT
// inside a transaction so readers always see a consistent snapshot — no
// partial state where some (stratum, gw) buckets are missing.
//
// Tiny output: 3 strata × ≤38 GWs = ≤114 rows. The expensive part is the
// GROUP BY over manager_cumulative (~75M rows on prod) — typically ~30–60s
// on the prod CX23. This runs once per cron cycle (15 min cadence), not
// per request, which is the entire point: the per-request DISTINCT ON
// over the same partition is what was costing 15–25 s on cold cache.
//
// Population filter (stable_managers CTE): the read path subtracts
// (sum at end_gw) − (sum at start_gw − 1). That subtraction is only
// well-defined when the SAME set of managers contributes to both
// endpoints. Without a filter, managers whose latest manager_cumulative
// row is some past GW (ingested weeks ago, not yet re-walked) contribute
// to the start anchor but not the end, producing negative deltas in
// sampleStratumAggregates. The CTE restricts every (stratum, gw) row to
// managers who have a row at the current max GW — i.e. the cohort that
// is actually up-to-date — so the subtraction is well-defined.
//
// Exported so rebuildManagerReadModels can call this out-of-band (e.g.
// immediately after applying the schema migration so the new read path
// has a populated table to read from before the next 15-minute populate
// tick).
export const rebuildStratumGwRunningStats = async (): Promise<void> => {
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`TRUNCATE stratum_gw_running_stats`),
    prisma.$executeRawUnsafe(`
      WITH current_max AS (
        SELECT MAX(gw) AS gw FROM manager_cumulative
      ),
      stable_managers AS (
        SELECT mc.entry_id
        FROM manager_cumulative mc
        JOIN current_max cm ON mc.gw = cm.gw
      )
      INSERT INTO stratum_gw_running_stats
        (stratum, gw, sample_size,
         sum_cum_points, sum_cum_transfers, sum_cum_hits_cost,
         sum_cum_bench, sum_cum_captain_bonus, sum_gws_played,
         count_with_transfers, count_with_hits, count_with_bench,
         count_with_chips,
         cum_wildcards_h1, cum_wildcards_h2,
         cum_freehits_h1,  cum_freehits_h2,
         cum_bboosts_h1,   cum_bboosts_h2,
         last_rebuilt)
      SELECT
        mc.stratum,
        mc.gw,
        COUNT(*)::int                                              AS sample_size,
        SUM(mc.cumulative_points)::bigint                          AS sum_cum_points,
        SUM(mc.cumulative_transfers)::bigint                       AS sum_cum_transfers,
        SUM(mc.cumulative_hits_cost)::bigint                       AS sum_cum_hits_cost,
        SUM(mc.cumulative_bench)::bigint                           AS sum_cum_bench,
        SUM(mc.cumulative_captain_bonus)::bigint                   AS sum_cum_captain_bonus,
        SUM(mc.gws_played)::bigint                                 AS sum_gws_played,
        COUNT(*) FILTER (WHERE mc.has_transfers)::int              AS count_with_transfers,
        COUNT(*) FILTER (WHERE mc.has_hits)::int                   AS count_with_hits,
        COUNT(*) FILTER (WHERE mc.has_bench)::int                  AS count_with_bench,
        COUNT(*) FILTER (WHERE ms.has_chip_history)::int           AS count_with_chips,
        COUNT(*) FILTER (WHERE mc.chip_wildcard_h1)::int           AS cum_wildcards_h1,
        COUNT(*) FILTER (WHERE mc.chip_wildcard_h2)::int           AS cum_wildcards_h2,
        COUNT(*) FILTER (WHERE mc.chip_freehit_h1)::int            AS cum_freehits_h1,
        COUNT(*) FILTER (WHERE mc.chip_freehit_h2)::int            AS cum_freehits_h2,
        COUNT(*) FILTER (WHERE mc.chip_bboost_h1)::int             AS cum_bboosts_h1,
        COUNT(*) FILTER (WHERE mc.chip_bboost_h2)::int             AS cum_bboosts_h2,
        NOW()                                                      AS last_rebuilt
      FROM manager_cumulative mc
      JOIN stable_managers sm ON sm.entry_id = mc.entry_id
      JOIN manager_summary ms ON ms.entry_id = mc.entry_id
      GROUP BY mc.stratum, mc.gw
    `),
  ]);
};

// Per-(comparison cohort, start_gw, end_gw) precomputed avg net points per
// transfer. For start_gw > 1, stratum is determined by overall rank after
// start_gw - 1, before any points in the selected range can affect it. Ranges
// beginning at GW1 use end-GW rank so the UI can describe what managers who
// finished the selected range in the Top 100k/10k did.
// Replaces the per-request sampleAvgPtsPerTransfer query that dominated
// comparison-endpoint latency. See stratum_range_xfer_avg in schema.prisma
// for the model and read-path semantics.
//
// Two modes:
//   - `endGwOnly` (cron): refresh only the rows for end_gw=currentGw.
//     The aggregation cost scales with one end_gw column (~currentGw rows ×
//     3 strata) instead of the full grid (~currentGw²/2 rows × 3). Older
//     end_gws are left in place — they drift slightly as new managers
//     ingest, but the drift is bounded (~few percent per cron) and a manual
//     backfill resyncs.
//   - no args (backfill): full rebuild of every (start_gw, end_gw) row.
//     TRUNCATE then INSERT one (start_gw, end_gw) at a time so each query's
//     working set stays bounded; total runtime is ~10-30 min on prod.
//
// Each per-(start_gw, end_gw) INSERT is structurally the same query that
// sampleAvgPtsPerTransfer ran per request, just executed once per range
// instead of once per request. The FULL stratum-3 ingested sample is used
// (no entry_id % 32 sub-sample), which improves precision vs the previous
// request-time path.
export const rebuildStratumRangeXferAvg = async (options?: {
  endGwOnly?: number;
}): Promise<void> => {
  const sampledGw = await prisma.manager_cumulative.aggregate({
    _max: { gw: true },
  });
  const maxGw = sampledGw._max.gw ?? 0;
  if (maxGw < 1) {
    if (options?.endGwOnly === undefined) {
      await prisma.$executeRawUnsafe(`TRUNCATE stratum_range_xfer_avg`);
    }
    return;
  }

  const endGws =
    options?.endGwOnly !== undefined
      ? options.endGwOnly >= 1 && options.endGwOnly <= maxGw
        ? [options.endGwOnly]
        : []
      : Array.from({ length: maxGw }, (_, i) => i + 1);

  if (options?.endGwOnly === undefined) {
    await prisma.$executeRawUnsafe(`TRUNCATE stratum_range_xfer_avg`);
  } else if (endGws.length > 0) {
    // Brief inconsistency window (~1-3s per start_gw) where readers see
    // missing rows for this end_gw column. Acceptable: read path returns
    // null for missing rows, which the UI renders the same as
    // not-enough-data. UPSERT would avoid the window but complicates the
    // SQL; the gap is small enough not to bother.
    await prisma.$executeRawUnsafe(
      `DELETE FROM stratum_range_xfer_avg WHERE end_gw = $1`,
      options.endGwOnly,
    );
  }

  for (const endGw of endGws) {
    for (let startGw = 1; startGw <= endGw; startGw++) {
      await prisma.$executeRawUnsafe(
        `
        INSERT INTO stratum_range_xfer_avg
          (stratum, start_gw, end_gw, sum_per_manager_avg, managers_with_xfers,
           with_data, stratum_size, last_rebuilt)
        WITH point_windows AS (
          SELECT h.footballer_id, gw_series.gw,
                 SUM(h.total_points)::float AS pts
          FROM generate_series($1::int, $2::int) AS gw_series(gw)
          JOIN history h ON h.round BETWEEN gw_series.gw AND $2::int
          GROUP BY h.footballer_id, gw_series.gw
        ),
        per_manager AS (
          SELECT
                 mt.entry_id,
                 CASE
                   WHEN cohort_rank.overall_rank BETWEEN 1 AND 10000 THEN 1
                   WHEN cohort_rank.overall_rank BETWEEN 10001 AND 100000 THEN 2
                   WHEN cohort_rank.overall_rank > 100000 THEN 3
                   ELSE NULL
                 END::int AS stratum,
                 SUM(COALESCE(in_pts.pts, 0) - COALESCE(out_pts.pts, 0))::float AS net,
                 COUNT(*)::int AS xfers
          FROM manager_transfers mt
          JOIN manager_history cohort_rank
            ON cohort_rank.entry_id = mt.entry_id
           AND cohort_rank.gw = CASE WHEN $1::int = 1 THEN $2::int ELSE $1::int - 1 END
          LEFT JOIN point_windows in_pts
            ON in_pts.footballer_id = mt.in_element AND in_pts.gw = mt.gw
          LEFT JOIN point_windows out_pts
            ON out_pts.footballer_id = mt.out_element AND out_pts.gw = mt.gw
          WHERE mt.gw BETWEEN $1::int AND $2::int
            AND cohort_rank.overall_rank > 0
          GROUP BY mt.entry_id, cohort_rank.overall_rank
        ),
        agg AS (
          SELECT stratum,
                 SUM(net / NULLIF(xfers, 0))::float AS sum_per_manager_avg,
                 COUNT(*)::int AS managers_with_xfers
          FROM per_manager
          WHERE xfers > 0
          GROUP BY 1
        ),
        sizes AS (
          SELECT
                 CASE
                   WHEN mh.overall_rank BETWEEN 1 AND 10000 THEN 1
                   WHEN mh.overall_rank BETWEEN 10001 AND 100000 THEN 2
                   WHEN mh.overall_rank > 100000 THEN 3
                   ELSE NULL
                 END::int AS stratum,
                 COUNT(*) FILTER (WHERE ms.has_transfer_history)::int AS with_data,
                 COUNT(*)::int AS stratum_size
          FROM manager_summary ms
          JOIN manager_history mh
            ON mh.entry_id = ms.entry_id
           AND mh.gw = CASE WHEN $1::int = 1 THEN $2::int ELSE $1::int - 1 END
          WHERE mh.overall_rank > 0
          GROUP BY 1
        ),
        strata AS (SELECT unnest(ARRAY[1, 2, 3]::int[]) AS stratum)
        SELECT
          st.stratum,
          $1::int,
          $2::int,
          COALESCE(a.sum_per_manager_avg, 0)::float,
          COALESCE(a.managers_with_xfers, 0)::int,
          COALESCE(sz.with_data, 0)::int,
          COALESCE(sz.stratum_size, 0)::int,
          NOW()
        FROM strata st
        LEFT JOIN sizes sz ON sz.stratum = st.stratum
        LEFT JOIN agg a ON a.stratum = st.stratum
        `,
        startGw,
        endGw,
      );
    }
  }
};

type RangeScoreBucketRebuildOptions = {
  endGwOnly?: number;
};

const rebuildManagerRangeScoreBucketsForEndGw = async (
  endGw: number,
): Promise<void> => {
  await prisma.$transaction([
    prisma.$executeRawUnsafe(
      `DROP TABLE IF EXISTS tmp_manager_range_bucket_end`,
    ),
    prisma.$executeRawUnsafe(
      `DROP TABLE IF EXISTS tmp_manager_range_bucket_start`,
    ),
    prisma.$executeRaw`
      CREATE TEMP TABLE tmp_manager_range_bucket_end
      ON COMMIT DROP
      AS
      SELECT
        mc.entry_id,
        COALESCE(
          CASE
            WHEN mh.overall_rank > 0 AND mh.overall_rank <= 10000 THEN 1
            WHEN mh.overall_rank > 10000 AND mh.overall_rank <= 100000 THEN 2
            WHEN mh.overall_rank > 100000 THEN 3
            ELSE NULL
          END,
          mc.stratum
        )::int AS stratum,
        mc.cumulative_points
      FROM manager_cumulative mc
      LEFT JOIN manager_history mh
        ON mh.entry_id = mc.entry_id AND mh.gw = mc.gw
      WHERE mc.gw = ${endGw}
    `,
    prisma.$executeRaw`
      CREATE TEMP TABLE tmp_manager_range_bucket_start
      ON COMMIT DROP
      AS
      SELECT c.entry_id, c.gw, c.cumulative_points
      FROM manager_cumulative c
      JOIN tmp_manager_range_bucket_end e ON e.entry_id = c.entry_id
      WHERE c.gw >= 1 AND c.gw < ${endGw}
    `,
    prisma.$executeRawUnsafe(
      `CREATE INDEX tmp_manager_range_bucket_start_idx
       ON tmp_manager_range_bucket_start (entry_id, gw)`,
    ),
    prisma.$executeRawUnsafe(`ANALYZE tmp_manager_range_bucket_end`),
    prisma.$executeRawUnsafe(`ANALYZE tmp_manager_range_bucket_start`),
    prisma.$executeRaw`
      DELETE FROM manager_range_score_buckets
      WHERE end_gw = ${endGw}
    `,
    prisma.$executeRaw`
      INSERT INTO manager_range_score_buckets
        (stratum, start_gw, end_gw, range_total, managers, last_rebuilt)
      WITH starts AS (
        SELECT generate_series(1, ${endGw})::int AS start_gw
      )
      SELECT
        c_end.stratum,
        starts.start_gw,
        ${endGw}::int AS end_gw,
        (c_end.cumulative_points - COALESCE(c_start.cumulative_points, 0))::int
          AS range_total,
        COUNT(*)::int AS managers,
        NOW() AS last_rebuilt
      FROM tmp_manager_range_bucket_end c_end
      CROSS JOIN starts
      LEFT JOIN tmp_manager_range_bucket_start c_start
        ON c_start.entry_id = c_end.entry_id
       AND c_start.gw = starts.start_gw - 1
      GROUP BY
        c_end.stratum,
        starts.start_gw,
        c_end.cumulative_points - COALESCE(c_start.cumulative_points, 0)
    `,
  ]);
};

export const rebuildManagerRangeScoreBuckets = async ({
  endGwOnly,
}: RangeScoreBucketRebuildOptions = {}): Promise<void> => {
  const sampledGw = await prisma.manager_cumulative.aggregate({
    _max: { gw: true },
  });
  const currentGw = sampledGw._max.gw ?? (await getCurrentSampleGameweek()).gw;
  if (currentGw < 1) {
    await prisma.$executeRawUnsafe(`TRUNCATE manager_range_score_buckets`);
    return;
  }

  if (endGwOnly !== undefined) {
    const endGw = Math.min(Math.max(endGwOnly, 1), currentGw);
    await rebuildManagerRangeScoreBucketsForEndGw(endGw);
    return;
  }

  await prisma.$executeRaw`
    DELETE FROM manager_range_score_buckets
    WHERE end_gw > ${currentGw}
  `;
  for (let endGw = 1; endGw <= currentGw; endGw += 1) {
    await rebuildManagerRangeScoreBucketsForEndGw(endGw);
  }
};

export const rangeScoreBucketsNeedRefresh = async (
  endGw: number,
): Promise<boolean> => {
  const rows = await prisma.$queryRaw<
    Array<{
      cumulative_sample: number;
      bucket_sample: number;
    }>
  >`
    WITH cumulative AS (
      SELECT
        COALESCE(
          CASE
            WHEN mh.overall_rank > 0 AND mh.overall_rank <= 10000 THEN 1
            WHEN mh.overall_rank > 10000 AND mh.overall_rank <= 100000 THEN 2
            WHEN mh.overall_rank > 100000 THEN 3
            ELSE NULL
          END,
          mc.stratum
        )::int AS stratum,
        COUNT(*)::int AS sample_size
      FROM manager_cumulative mc
      LEFT JOIN manager_history mh
        ON mh.entry_id = mc.entry_id AND mh.gw = mc.gw
      WHERE mc.gw = ${endGw}
      GROUP BY 1
    ),
    buckets AS (
      SELECT stratum, SUM(managers)::int AS sample_size
      FROM manager_range_score_buckets
      WHERE start_gw = 1 AND end_gw = ${endGw}
      GROUP BY stratum
    )
    SELECT
      COALESCE(c.sample_size, 0)::int AS cumulative_sample,
      COALESCE(b.sample_size, 0)::int AS bucket_sample
    FROM cumulative c
    FULL OUTER JOIN buckets b ON b.stratum = c.stratum
  `;

  return rows.some((row) => row.cumulative_sample !== row.bucket_sample);
};
