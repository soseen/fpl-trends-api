import type { Request, Response } from "express";
import { prisma } from "../database/client.js";

type BulkDataHealth = {
  status: "ok" | "degraded";
  lastSuccessfulRefresh: string | null;
  events: {
    count: number;
    latestEventId: number | null;
    latestCheckedEventId: number | null;
    currentEventId: number | null;
  };
  history: {
    latestRound: number | null;
    latestRoundRows: number;
  };
  issues: string[];
};

export async function getHealth(_req: Request, res: Response): Promise<void> {
  const t0 = Date.now();
  let dbOk = false;
  let feedOk = false;
  let bulkOk = false;
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
  let bulkData: BulkDataHealth | null = null;
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
    const [refresh, eventRows, historyRows] = await Promise.all([
      prisma.app_metadata.findUnique({
        where: { key: "bulk_data_refresh_version" },
        select: { value: true },
      }),
      prisma.$queryRaw<
        Array<{
          event_count: bigint;
          latest_event_id: number | null;
          latest_checked_event_id: number | null;
          current_event_id: number | null;
        }>
      >`
        SELECT COUNT(*)::bigint AS event_count,
               MAX(id) AS latest_event_id,
               MAX(id) FILTER (WHERE finished AND data_checked) AS latest_checked_event_id,
               MAX(id) FILTER (WHERE is_current) AS current_event_id
        FROM events
      `,
      prisma.$queryRaw<
        Array<{ latest_round: number | null; latest_round_rows: bigint }>
      >`
        WITH latest AS (SELECT MAX(round) AS round FROM history)
        SELECT latest.round AS latest_round,
               COUNT(history.round)::bigint AS latest_round_rows
        FROM latest
        LEFT JOIN history ON history.round = latest.round
        GROUP BY latest.round
      `,
    ]);
    const eventSummary = eventRows[0];
    const historySummary = historyRows[0];
    const latestEventId = eventSummary?.latest_event_id ?? null;
    const latestHistoryRound = historySummary?.latest_round ?? null;
    const issues: string[] = [];
    if (!refresh) issues.push("missing_bulk_data_refresh_marker");
    if (
      latestHistoryRound !== null &&
      latestEventId !== null &&
      latestHistoryRound > latestEventId
    ) {
      issues.push("history_ahead_of_events");
    }
    if (latestHistoryRound !== null && latestEventId === null) {
      issues.push("history_without_events");
    }
    bulkData = {
      status: issues.length === 0 ? "ok" : "degraded",
      lastSuccessfulRefresh: refresh?.value ?? null,
      events: {
        count: Number(eventSummary?.event_count ?? 0n),
        latestEventId,
        latestCheckedEventId: eventSummary?.latest_checked_event_id ?? null,
        currentEventId: eventSummary?.current_event_id ?? null,
      },
      history: {
        latestRound: latestHistoryRound,
        latestRoundRows: Number(historySummary?.latest_round_rows ?? 0n),
      },
      issues,
    };
    bulkOk = bulkData.status === "ok";
  } catch (error: unknown) {
    console.error("Health check DB ping failed:", error);
  }
  const healthy = dbOk && feedOk && bulkOk;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    db: dbOk ? { status: "up", latencyMs: dbLatencyMs } : { status: "down" },
    penaltyFeed,
    bulkData,
    elapsedMs: Date.now() - t0,
  });
}
