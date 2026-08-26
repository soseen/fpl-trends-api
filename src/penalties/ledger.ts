import type { penalty_feed_sync, penalty_records } from "@prisma/client";
import { prisma } from "../database/client.js";

export const penaltyRecordKey = (
  fixtureCode: number,
  playerCode: number,
): string => `${fixtureCode}:${playerCode}`;

export const getPenaltyRecordMap = async (
  season: string,
): Promise<Map<string, penalty_records>> => {
  const rows = await prisma.penalty_records.findMany({ where: { season } });
  return new Map(
    rows.map((row) => [
      penaltyRecordKey(row.fixture_code, row.player_code),
      row,
    ]),
  );
};

export type PlayerSeasonPenaltyTotals = {
  scored: number;
  missed: number;
};

export const getPlayerSeasonPenaltyTotals = async (): Promise<
  Map<string, PlayerSeasonPenaltyTotals>
> => {
  const rows = await prisma.penalty_records.groupBy({
    by: ["season", "player_code"],
    _sum: { scored: true, missed: true },
  });
  return new Map(
    rows.map((row) => [
      `${row.season}:${row.player_code}`,
      { scored: row._sum.scored ?? 0, missed: row._sum.missed ?? 0 },
    ]),
  );
};

type HistoricalCoverage = Pick<
  penalty_feed_sync,
  | "deep_event_coverage"
  | "final_season"
  | "completed_fixture_count"
  | "mapped_fixture_count"
>;

export const hasHistoricalPenaltyCoverage = (
  sync: HistoricalCoverage,
): boolean =>
  sync.deep_event_coverage ||
  (sync.final_season &&
    sync.completed_fixture_count === 380 &&
    sync.mapped_fixture_count === 380);

export const getDeepCoveredSeasons = async (): Promise<Set<string>> => {
  const rows = await prisma.penalty_feed_sync.findMany({
    select: {
      season: true,
      deep_event_coverage: true,
      final_season: true,
      completed_fixture_count: true,
      mapped_fixture_count: true,
    },
  });
  // Deep fixture events are required for older archives that no longer expose
  // per-fixture FPL misses. A season finalized while current is equally exact:
  // PL supplies every scored penalty and FPL supplies every fixture miss.
  return new Set(
    rows.filter(hasHistoricalPenaltyCoverage).map((row) => row.season),
  );
};
