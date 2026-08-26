import type { penalty_records } from "@prisma/client";
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

export const getDeepCoveredSeasons = async (): Promise<Set<string>> => {
  const rows = await prisma.penalty_feed_sync.findMany({
    where: { deep_event_coverage: true },
    select: { season: true },
  });
  return new Set(rows.map((row) => row.season));
};
