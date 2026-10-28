import { prisma } from "../database/client.js";
import { pruneWorkingFacts } from "./retention.js";

// Only evict derived generations/caches here. Historical source facts require
// an explicitly verified archive before any storage-reclamation operation.
export const maintainAnalytics = async (): Promise<void> => {
  await prisma.$executeRaw`WITH stale AS (
    SELECT season,entry_id,kind FROM analytics_manager_sources
    WHERE kind LIKE 'top10k-followup-v1:%' AND fetched_at < now()-interval '7 days'
    LIMIT 500
  ) DELETE FROM analytics_manager_sources s USING stale
    WHERE s.season=stale.season AND s.entry_id=stale.entry_id AND s.kind=stale.kind`;
  // Arbitrary user IDs do not necessarily have a sampled manager_summary row.
  // Retire their refetchable caches too, while protecting active results/jobs.
  await prisma.$executeRaw`WITH stale AS (
    SELECT DISTINCT s.entry_id FROM analytics_manager_sources s WHERE s.fetched_at<now()-interval '30 days'
      AND NOT EXISTS(SELECT 1 FROM manager_summary ms WHERE ms.entry_id=s.entry_id)
      AND NOT EXISTS(SELECT 1 FROM analytics_manager_results r WHERE r.entry_id=s.entry_id AND r.created_at>now()-interval '30 days')
      AND NOT EXISTS(SELECT 1 FROM analytics_jobs j WHERE j.entry_id=s.entry_id AND j.status IN ('queued','running')) LIMIT 500
  ), picks AS (DELETE FROM manager_pick_elements WHERE entry_id IN (SELECT entry_id FROM stale) RETURNING entry_id),
  transfers AS (DELETE FROM manager_transfers WHERE entry_id IN (SELECT entry_id FROM stale) RETURNING entry_id)
  DELETE FROM analytics_manager_sources WHERE entry_id IN (SELECT entry_id FROM stale)`;
  await prisma.$executeRaw`DELETE FROM analytics_benchmarks b USING (
    SELECT id,row_number() OVER(PARTITION BY season,gw ORDER BY created_at DESC,id) AS n FROM analytics_benchmarks
  ) old WHERE old.id=b.id AND old.n>2 AND NOT EXISTS(SELECT 1 FROM analytics_publications p WHERE p.benchmark_id=b.id)`;
  await prisma.$executeRaw`DELETE FROM analytics_manager_results WHERE expires_at<now()-interval '7 days'`;
  await prisma.$executeRaw`WITH ranked AS (
    SELECT season,entry_id,start_gw,end_gw,created_at,row_number() OVER(PARTITION BY season,entry_id ORDER BY created_at DESC,start_gw,end_gw) AS n
    FROM analytics_manager_results
  ) DELETE FROM analytics_manager_results r USING ranked old
  WHERE old.season=r.season AND old.entry_id=r.entry_id AND old.start_gw=r.start_gw AND old.end_gw=r.end_gw
    AND old.n>20 AND old.created_at<now()-interval '10 minutes'`;
  await prisma.$executeRaw`DELETE FROM analytics_jobs WHERE status='succeeded' AND updated_at<now()-interval '1 day'`;
  await prisma.$executeRaw`DELETE FROM analytics_jobs WHERE status='failed' AND updated_at<now()-interval '30 days'`;
  if (process.env["ANALYTICS_PRUNE_WORKING_FACTS"] === "true") {
    try {
      const count = await pruneWorkingFacts(true);
      if (count)
        console.info(
          JSON.stringify({
            event: "analytics_working_retention",
            batch: count,
          }),
        );
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "analytics_retention_deferred",
          cause: String(error),
        }),
      );
    }
  }
};
