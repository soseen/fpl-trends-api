import "dotenv/config";
import fs from "fs";
import { fileURLToPath } from "node:url";
import { type Prisma } from "@prisma/client";
import { fetchBootstrapStatic } from "../bootstrapStatic/fetchBootstrapStatic.js";
import type { BootstrapStaticData } from "../bootstrapStatic/types.js";
import {
  RAW_BOOTSTRAP_STATIC_FILE,
  RAW_FOOTBALLERS_FILE,
} from "../file.helpers.js";
import { getFixturesData } from "../fetch.js";
import { fetchFootballers } from "../footballers/fetchFootballers.js";
import type { Footballer } from "../footballers/types.js";
import { enrichArchive } from "../nonPenalty/enrichArchive.js";
import { enrichHistoryPast } from "../nonPenalty/historyPast.js";
import {
  getDeepCoveredSeasons,
  getPenaltyRecordMap,
  getPlayerSeasonPenaltyTotals,
  penaltyRecordKey,
} from "../penalties/ledger.js";
import { normalizeSeasonLabel } from "../penalties/premierLeagueFeed.js";
import { syncPenaltyFeed } from "../penalties/syncPenaltyFeed.js";
import { prisma } from "./client.js";
import { insertTeamHistory } from "./insertTeamHistory.js";
import { deriveSeasonFromEvents, getStoredSeason } from "./seasonManager.js";

type JsonRow = Record<string, unknown>;

const asRows = (value: unknown): JsonRow[] =>
  Array.isArray(value)
    ? value.filter(
        (row): row is JsonRow =>
          Boolean(row) && typeof row === "object" && !Array.isArray(row),
      )
    : [];

const toInputJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const historyPastSeasons = (footballers: unknown): Set<string> => {
  const result = new Set<string>();
  for (const footballer of asRows(footballers)) {
    for (const row of asRows(footballer["history_past"])) {
      const expectedGoals = Number(row["expected_goals"] ?? 0);
      const expectedGoalInvolvements = Number(
        row["expected_goal_involvements"] ?? 0,
      );
      if (expectedGoals <= 0 && expectedGoalInvolvements <= 0) {
        continue;
      }
      const season = normalizeSeasonLabel(row["season_name"]);
      if (!season) {
        throw new Error(
          `Invalid history_past season label: ${String(row["season_name"])}`,
        );
      }
      result.add(season);
    }
  }
  return result;
};

const ensureCurrentSourceFiles = async (): Promise<void> => {
  // A repeatable production backfill must reconcile against the live FPL
  // snapshot, not whichever cache happened to be left by the prior cron run.
  await fetchBootstrapStatic();
  await fetchFootballers();
};

const backfillCurrentRows = async (
  season: string,
  bootstrap: BootstrapStaticData,
  footballers: Record<string, Footballer>,
): Promise<void> => {
  const fixtures = await getFixturesData();
  await syncPenaltyFeed({
    season,
    bootstrap,
    footballers,
    fplFixtures: fixtures,
    finalSeason: bootstrap.events.every(
      (event) => event.finished && event.data_checked,
    ),
  });
  const fixtureCodes = new Map(
    fixtures.map((fixture) => [fixture.id, fixture.code]),
  );
  const playerCodes = new Map(
    bootstrap.elements.map((player) => [player.id, player.code]),
  );
  const penalties = await getPenaltyRecordMap(season);
  const historyRows = await prisma.history.findMany({
    select: {
      footballer_id: true,
      fixture_id: true,
      penalties_missed: true,
    },
  });
  const updates = historyRows.map((row) => {
    const fixtureCode = fixtureCodes.get(row.fixture_id);
    const playerCode = playerCodes.get(row.footballer_id);
    if (!fixtureCode || !playerCode) {
      throw new Error(
        `Cannot map current history ${row.footballer_id}:${row.fixture_id}.`,
      );
    }
    const penalty = penalties.get(penaltyRecordKey(fixtureCode, playerCode));
    if ((penalty?.missed ?? 0) !== row.penalties_missed) {
      throw new Error(
        `Current penalty miss mismatch for player ${playerCode}, fixture ${fixtureCode}.`,
      );
    }
    return prisma.history.update({
      where: {
        footballer_id_fixture_id: {
          footballer_id: row.footballer_id,
          fixture_id: row.fixture_id,
        },
      },
      data: {
        fixture_code: fixtureCode,
        penalties_scored: penalty?.scored ?? 0,
      },
    });
  });
  await prisma.$transaction(updates);

  const [totals, covered] = await Promise.all([
    getPlayerSeasonPenaltyTotals(),
    getDeepCoveredSeasons(),
  ]);
  const players = await prisma.footballers.findMany({
    select: { id: true, code: true, history_past: true },
  });
  await prisma.$transaction(
    players.map((player) => {
      if (!player.code)
        throw new Error(`Player ${player.id} has no Opta code.`);
      const enriched = asRows(player.history_past).map((row) =>
        enrichHistoryPast(row, player.code!, totals, covered),
      );
      return prisma.footballers.update({
        where: { id: player.id },
        data: { history_past: toInputJson(enriched) },
      });
    }),
  );
  await insertTeamHistory(season, fixtures);
};

export const backfillNonPenalty = async (): Promise<void> => {
  await ensureCurrentSourceFiles();
  const bootstrap = JSON.parse(
    fs.readFileSync(RAW_BOOTSTRAP_STATIC_FILE, "utf8"),
  ) as BootstrapStaticData;
  const footballers = JSON.parse(
    fs.readFileSync(RAW_FOOTBALLERS_FILE, "utf8"),
  ) as Record<string, Footballer>;
  const currentSeason = await getStoredSeason();
  if (!currentSeason) throw new Error("No current season is stored.");
  const sourceSeason = deriveSeasonFromEvents(bootstrap.events);
  if (sourceSeason !== currentSeason) {
    throw new Error(
      `Cached FPL source season ${sourceSeason ?? "unknown"} does not match stored season ${currentSeason}.`,
    );
  }

  const archives = await prisma.season_archives.findMany({
    orderBy: { season: "asc" },
  });
  const seasonsToDeepSync = historyPastSeasons(
    Object.values(footballers).map((footballer) => ({
      history_past: footballer.history_past,
    })),
  );
  for (const archive of archives) {
    seasonsToDeepSync.add(archive.season);
    for (const season of historyPastSeasons(archive.footballers_data)) {
      seasonsToDeepSync.add(season);
    }
  }
  seasonsToDeepSync.delete(currentSeason);

  for (const season of [...seasonsToDeepSync].sort()) {
    console.info(`[backfillNonPenalty] Fetching complete ${season} events...`);
    await syncPenaltyFeed({ season, finalSeason: true, deep: true });
  }

  await backfillCurrentRows(currentSeason, bootstrap, footballers);
  const [penaltyTotals, deepCoveredSeasons] = await Promise.all([
    getPlayerSeasonPenaltyTotals(),
    getDeepCoveredSeasons(),
  ]);

  for (const archive of archives) {
    const [fixtures, penaltyRecords, fixturePlayers] = await Promise.all([
      prisma.penalty_fixtures.findMany({
        where: { season: archive.season },
      }),
      prisma.penalty_records.findMany({
        where: { season: archive.season },
      }),
      prisma.penalty_fixture_players.findMany({
        where: { season: archive.season },
      }),
    ]);
    const enriched = enrichArchive({
      season: archive.season,
      footballers: archive.footballers_data,
      teams: archive.teams_data,
      fixtures,
      penaltyRecords,
      fixturePlayers,
      penaltyTotals,
      deepCoveredSeasons,
    });
    await prisma.season_archives.update({
      where: { season: archive.season },
      data: {
        footballers_data: toInputJson(enriched.footballers),
        teams_data: toInputJson(enriched.teams),
      },
    });
    console.info(`[backfillNonPenalty] Backfilled ${archive.season}.`);
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await backfillNonPenalty();
    console.info("Non-penalty backfill completed successfully.");
  } catch (error) {
    console.error("Non-penalty backfill failed:", error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
