import { type Prisma } from "@prisma/client";
import { getEvents } from "../events/getEvents.js";
import { getFootballersWithHistoryAndFixtures } from "../footballers/getAllFootballersData.js";
import { getTeamsData } from "../teams/getTeamsData.js";
import { prisma } from "./client.js";
import {
  assertFootballerAnalyticsShape,
  assertTeamAnalyticsShape,
} from "../nonPenalty/apiShape.js";

const SEASON_PATTERN = /^\d{4}-\d{2}$/;
const CURRENT_SEASON_KEY = "current_season";

export class SeasonArchiveNotFoundError extends Error {
  constructor(season: string) {
    super(`Season archive ${season} was not found.`);
    this.name = "SeasonArchiveNotFoundError";
  }
}

const toInputJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export const normalizeSeason = (value: unknown): string | null => {
  if (typeof value !== "string" || !SEASON_PATTERN.test(value)) return null;
  return value;
};

export const archiveCurrentSeason = async (
  season: string | null,
): Promise<boolean> => {
  if (!season || !SEASON_PATTERN.test(season)) {
    console.info("[seasonArchive] No valid outgoing season to archive.");
    return false;
  }

  const existing = await prisma.season_archives.findUnique({
    where: { season },
    select: { season: true },
  });
  if (existing) {
    console.info(`[seasonArchive] ${season} is already archived.`);
    return true;
  }

  const [footballers, teams, events] = await Promise.all([
    getFootballersWithHistoryAndFixtures(),
    getTeamsData(),
    getEvents(),
  ]);

  if (footballers.length === 0 || teams.length === 0) {
    throw new Error(
      `[seasonArchive] Refusing to reset ${season}: the outgoing player/team dataset is empty.`,
    );
  }

  const totalPlayers = events.reduce(
    (maximum, event) => Math.max(maximum, event.ranked_count),
    0,
  );

  await prisma.season_archives.create({
    data: {
      season,
      footballers_data: toInputJson(footballers),
      teams_data: toInputJson(teams),
      events_data: toInputJson(events),
      total_players: totalPlayers,
    },
  });

  console.info(
    `[seasonArchive] Archived ${season}: ${footballers.length} players, ${teams.length} teams, ${events.length} events.`,
  );
  return true;
};

export type SeasonArchiveDataset =
  | "footballers_data"
  | "teams_data"
  | "events_data"
  | "total_players";

export const getSeasonArchiveDataset = async (
  season: string,
  dataset: SeasonArchiveDataset,
): Promise<unknown> => {
  const archive = await prisma.season_archives.findUnique({
    where: { season },
    select: {
      footballers_data: dataset === "footballers_data",
      teams_data: dataset === "teams_data",
      events_data: dataset === "events_data",
      total_players: dataset === "total_players",
    },
  });

  if (!archive) throw new SeasonArchiveNotFoundError(season);
  const value = archive[dataset];
  if (dataset === "footballers_data") {
    assertFootballerAnalyticsShape(value, `${season} footballers archive`);
  } else if (dataset === "teams_data") {
    assertTeamAnalyticsShape(value, `${season} teams archive`);
  }
  return value;
};

export const getSeasonCatalog = async () => {
  const [seasonRows, archives, latestFinishedEvent] = await Promise.all([
    prisma.app_metadata.findMany({
      where: { key: CURRENT_SEASON_KEY },
      select: { value: true },
      take: 1,
    }),
    prisma.season_archives.findMany({
      orderBy: { season: "desc" },
      select: { season: true, archived_at: true },
    }),
    prisma.events.findFirst({
      where: { finished: true, data_checked: true },
      orderBy: { id: "desc" },
      select: { id: true },
    }),
  ]);

  const currentSeason = seasonRows[0]?.value ?? null;
  const archivedSeasons = archives.map((archive) => archive.season);
  const isPreseason = latestFinishedEvent === null;

  return {
    currentSeason,
    archivedSeasons,
    availableSeasons: Array.from(
      new Set([currentSeason, ...archivedSeasons].filter(Boolean)),
    ),
    defaultAnalyticsSeason:
      isPreseason && archivedSeasons[0] ? archivedSeasons[0] : currentSeason,
    isPreseason,
    latestCompletedGameweek: latestFinishedEvent?.id ?? 0,
    archives,
  };
};
