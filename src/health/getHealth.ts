import type { Request, Response } from "express";
import { prisma } from "../database/client.js";

export async function getHealth(_req: Request, res: Response): Promise<void> {
  const t0 = Date.now();
  let dbOk = false;
  let feedOk = false;
  let dbLatencyMs: number | null = null;
  let penaltyFeed: {
    season: string;
    competitionSeasonId: number;
    completedFixtureCount: number;
    mappedFixtureCount: number;
    coverageComplete: boolean;
    scoredPenalties: number;
    missedPenalties: number;
    attempts: number;
    deepEventCoverage: boolean;
    finalSeason: boolean;
    lastSuccessfulRefresh: string;
  } | null = null;
  try {
    const dbT0 = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Date.now() - dbT0;
    dbOk = true;
    const currentSeason = await prisma.app_metadata.findUnique({
      where: { key: "current_season" },
      select: { value: true },
    });
    const sync = currentSeason
      ? await prisma.penalty_feed_sync.findUnique({
          where: { season: currentSeason.value },
        })
      : null;
    if (sync) {
      penaltyFeed = {
        season: sync.season,
        competitionSeasonId: sync.competition_season_id,
        completedFixtureCount: sync.completed_fixture_count,
        mappedFixtureCount: sync.mapped_fixture_count,
        coverageComplete:
          sync.completed_fixture_count === sync.mapped_fixture_count,
        scoredPenalties: sync.scored_penalties,
        missedPenalties: sync.missed_penalties,
        attempts: sync.scored_penalties + sync.missed_penalties,
        deepEventCoverage: sync.deep_event_coverage,
        finalSeason: sync.final_season,
        lastSuccessfulRefresh: sync.last_successful_refresh.toISOString(),
      };
      feedOk = sync.completed_fixture_count === sync.mapped_fixture_count;
    }
  } catch (error: unknown) {
    console.error("Health check DB ping failed:", error);
  }
  const healthy = dbOk && feedOk;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    db: dbOk ? { status: "up", latencyMs: dbLatencyMs } : { status: "down" },
    penaltyFeed,
    elapsedMs: Date.now() - t0,
  });
}
