import type { BootstrapStaticData } from "../bootstrapStatic/types.js";
import type { FplFixture, Footballer } from "../footballers/types.js";
import { delay } from "../utils.js";
import { prisma } from "../database/client.js";
import {
  fetchCompletedFixtures,
  fetchFixturePenaltyEvents,
  resolveCompetitionSeason,
  resolvePlayerOptaCode,
  type PremierLeagueFixture,
  type PremierLeaguePenaltyEvent,
} from "./premierLeagueFeed.js";

export type PenaltyLedgerRow = {
  season: string;
  fixture_code: number;
  player_code: number;
  gameweek: number | null;
  team_pulse_id: number | null;
  opponent_pulse_id: number | null;
  was_home: boolean | null;
  scored: number;
  missed: number;
};

type SyncOptions = {
  season: string;
  finalSeason: boolean;
  bootstrap?: BootstrapStaticData;
  footballers?: Record<string, Footballer>;
  fplFixtures?: FplFixture[];
  deep?: boolean;
};

const recordKey = (fixtureCode: number, playerCode: number): string =>
  `${fixtureCode}:${playerCode}`;

const isPublishableFplFixture = (fixture: FplFixture): boolean =>
  fixture.finished || fixture.finished_provisional === true;

const addEvent = (
  records: Map<string, PenaltyLedgerRow>,
  season: string,
  fixture: PremierLeagueFixture,
  playerCode: number,
  event: PremierLeaguePenaltyEvent,
): void => {
  if (event.teamId === null) {
    throw new Error(
      `[penaltyFeed] Penalty player ${playerCode} has no team mapping in fixture ${fixture.fixtureCode}.`,
    );
  }
  if (
    event.teamId !== fixture.homeTeamId &&
    event.teamId !== fixture.awayTeamId
  ) {
    throw new Error(
      `[penaltyFeed] Penalty player ${playerCode} mapped to team ${event.teamId}, which is not in fixture ${fixture.fixtureCode}.`,
    );
  }
  const wasHome = event.teamId === fixture.homeTeamId;
  const key = recordKey(fixture.fixtureCode, playerCode);
  const row = records.get(key) ?? {
    season,
    fixture_code: fixture.fixtureCode,
    player_code: playerCode,
    gameweek: fixture.gameweek,
    team_pulse_id: event.teamId,
    opponent_pulse_id: wasHome ? fixture.awayTeamId : fixture.homeTeamId,
    was_home: wasHome,
    scored: 0,
    missed: 0,
  };
  if (row.team_pulse_id !== event.teamId) {
    throw new Error(
      `[penaltyFeed] Conflicting team mapping for player ${playerCode} in fixture ${fixture.fixtureCode}.`,
    );
  }
  if (event.type === "P") row.scored++;
  else row.missed++;
  records.set(key, row);
};

export const validateListedScoredPenalties = (
  listed: PremierLeaguePenaltyEvent[],
  detailed: PremierLeaguePenaltyEvent[],
  fixtureCode: number,
): void => {
  const remaining = detailed.filter((event) => event.type === "P");
  for (const listedEvent of listed.filter((event) => event.type === "P")) {
    const matchIndex = remaining.findIndex(
      (event) =>
        event.personId === listedEvent.personId &&
        (listedEvent.teamId === null || event.teamId === listedEvent.teamId),
    );
    if (matchIndex < 0) {
      throw new Error(
        `[penaltyFeed] Listed/detail scored-penalty mismatch for fixture ${fixtureCode}.`,
      );
    }
    remaining.splice(matchIndex, 1);
  }
  if (remaining.length > 0) {
    throw new Error(
      `[penaltyFeed] Listed/detail scored-penalty mismatch for fixture ${fixtureCode}.`,
    );
  }
};

const resolvePlayers = async (
  events: PremierLeaguePenaltyEvent[],
): Promise<Map<number, number>> => {
  const result = new Map<number, number>();
  const ids = [...new Set(events.map((event) => event.personId))];
  for (const id of ids) result.set(id, await resolvePlayerOptaCode(id));
  return result;
};

export const validateFixtureCoverage = (
  plFixtures: PremierLeagueFixture[],
  fplFixtures: FplFixture[] | undefined,
): number => {
  if (!fplFixtures) return plFixtures.length;
  const plCodes = new Set(plFixtures.map((fixture) => fixture.fixtureCode));
  const fplCodes = new Set(
    fplFixtures.filter(isPublishableFplFixture).map((fixture) => fixture.code),
  );
  const missingFromPlFeed = [...fplCodes].filter((code) => !plCodes.has(code));
  const missingFromFplFixtures = [...plCodes].filter(
    (code) => !fplCodes.has(code),
  );
  if (missingFromPlFeed.length > 0 || missingFromFplFixtures.length > 0) {
    throw new Error(
      `[penaltyFeed] Fixture coverage is incomplete (missing from PL feed=${missingFromPlFeed.join(",") || "none"}; missing from FPL publishable fixtures=${missingFromFplFixtures.join(",") || "none"}).`,
    );
  }
  return fplCodes.size;
};

const addCurrentFplMisses = (
  records: Map<string, PenaltyLedgerRow>,
  options: Required<
    Pick<SyncOptions, "season" | "bootstrap" | "footballers" | "fplFixtures">
  >,
): void => {
  const fixtures = new Map(
    options.fplFixtures.map((fixture) => [fixture.id, fixture]),
  );
  const players = new Map(
    options.bootstrap.elements.map((player) => [player.id, player]),
  );
  const teams = new Map(options.bootstrap.teams.map((team) => [team.id, team]));

  for (const [elementIdRaw, summary] of Object.entries(options.footballers)) {
    const elementId = Number(elementIdRaw);
    const player = players.get(elementId);
    if (!player) {
      throw new Error(`[penaltyFeed] Missing FPL player ${elementId}.`);
    }
    for (const history of summary.history) {
      if (history.penalties_missed <= 0) continue;
      const fixture = fixtures.get(history.fixture);
      if (!fixture || !isPublishableFplFixture(fixture)) {
        throw new Error(
          `[penaltyFeed] Miss for player ${player.code} references unknown or incomplete FPL fixture ${history.fixture}.`,
        );
      }
      const teamId = history.was_home ? fixture.team_h : fixture.team_a;
      const opponentId = history.was_home ? fixture.team_a : fixture.team_h;
      const teamPulseId = teams.get(teamId)?.pulse_id;
      const opponentPulseId = teams.get(opponentId)?.pulse_id;
      if (!teamPulseId || !opponentPulseId) {
        throw new Error(
          `[penaltyFeed] Missing Pulse team mapping for FPL fixture ${fixture.code}.`,
        );
      }
      const key = recordKey(fixture.code, player.code);
      const existing = records.get(key);
      if (
        existing &&
        (existing.team_pulse_id !== teamPulseId ||
          existing.opponent_pulse_id !== opponentPulseId ||
          existing.was_home !== history.was_home)
      ) {
        throw new Error(
          `[penaltyFeed] PL/FPL team mapping conflict for player ${player.code}, fixture ${fixture.code}.`,
        );
      }
      records.set(key, {
        season: options.season,
        fixture_code: fixture.code,
        player_code: player.code,
        gameweek: fixture.event,
        team_pulse_id: teamPulseId,
        opponent_pulse_id: opponentPulseId,
        was_home: history.was_home,
        scored: existing?.scored ?? 0,
        missed: history.penalties_missed,
      });
    }
  }
};

const validateCurrentScoredRows = (
  records: Map<string, PenaltyLedgerRow>,
  bootstrap: BootstrapStaticData,
  footballers: Record<string, Footballer>,
  fplFixtures: FplFixture[],
): void => {
  const elementByCode = new Map(
    bootstrap.elements.map((player) => [player.code, player.id]),
  );
  const fixtureCodeById = new Map(
    fplFixtures.map((fixture) => [fixture.id, fixture.code]),
  );
  for (const record of records.values()) {
    if (record.scored === 0) continue;
    const elementId = elementByCode.get(record.player_code);
    const history = elementId
      ? footballers[String(elementId)]?.history.filter(
          (row) => fixtureCodeById.get(row.fixture) === record.fixture_code,
        )
      : undefined;
    if (history?.length !== 1 || !history[0]) {
      throw new Error(
        `[penaltyFeed] Scored penalty for player ${record.player_code}, fixture ${record.fixture_code} did not join to one FPL history row.`,
      );
    }
    if (history[0].goals_scored < record.scored) {
      throw new Error(
        `[penaltyFeed] Scored penalties exceed FPL goals for player ${record.player_code}, fixture ${record.fixture_code}.`,
      );
    }
  }
};

const fetchDeepFixtures = async (
  fixtures: PremierLeagueFixture[],
): Promise<PremierLeagueFixture[]> => {
  const result: PremierLeagueFixture[] = [];
  const requestedBatchSize = Number(
    process.env["PENALTY_FEED_BATCH_SIZE"] ?? 8,
  );
  const batchSize =
    Number.isInteger(requestedBatchSize) && requestedBatchSize > 0
      ? requestedBatchSize
      : 8;
  for (let index = 0; index < fixtures.length; index += batchSize) {
    const batch = fixtures.slice(index, index + batchSize);
    result.push(
      ...(await Promise.all(
        batch.map(async (fixture) => {
          const detailed = await fetchFixturePenaltyEvents(fixture.id);
          if (detailed.fixtureCode !== fixture.fixtureCode) {
            throw new Error(
              `[penaltyFeed] Fixture detail mismatch for ${fixture.fixtureCode}.`,
            );
          }
          validateListedScoredPenalties(
            fixture.goals,
            detailed.goals,
            fixture.fixtureCode,
          );
          return {
            ...detailed,
            gameweek: detailed.gameweek ?? fixture.gameweek,
          };
        }),
      )),
    );
    if (index + batchSize < fixtures.length) await delay(250);
  }
  return result;
};

const resolveCurrentEventTeamId = (
  event: PremierLeaguePenaltyEvent,
  fixture: PremierLeagueFixture,
  playerCode: number,
  options: Required<
    Pick<SyncOptions, "bootstrap" | "footballers" | "fplFixtures">
  >,
): number => {
  const player = options.bootstrap.elements.find(
    (element) => element.code === playerCode,
  );
  const fplFixture = options.fplFixtures.find(
    (candidate) => candidate.code === fixture.fixtureCode,
  );
  if (!player || !fplFixture) {
    throw new Error(
      `[penaltyFeed] Cannot join penalty player ${playerCode}, fixture ${fixture.fixtureCode} to current FPL data.`,
    );
  }
  const histories = options.footballers[String(player.id)]?.history.filter(
    (row) => row.fixture === fplFixture.id,
  );
  if (histories?.length !== 1 || !histories[0]) {
    throw new Error(
      `[penaltyFeed] Penalty player ${playerCode}, fixture ${fixture.fixtureCode} did not join to one FPL history row.`,
    );
  }
  const fplTeamId = histories[0].was_home
    ? fplFixture.team_h
    : fplFixture.team_a;
  const teamId = options.bootstrap.teams.find(
    (team) => team.id === fplTeamId,
  )?.pulse_id;
  if (!teamId) {
    throw new Error(
      `[penaltyFeed] Penalty player ${playerCode}, fixture ${fixture.fixtureCode} has no Pulse team mapping.`,
    );
  }
  if (event.teamId !== null && event.teamId !== teamId) {
    throw new Error(
      `[penaltyFeed] PL/FPL scored-penalty team conflict for player ${playerCode}, fixture ${fixture.fixtureCode}.`,
    );
  }
  return teamId;
};

export const syncPenaltyFeed = async (
  options: SyncOptions,
): Promise<PenaltyLedgerRow[]> => {
  const competitionSeason = await resolveCompetitionSeason(options.season);
  const listedFixtures = await fetchCompletedFixtures(competitionSeason.id);
  if (options.finalSeason && listedFixtures.length !== 380) {
    throw new Error(
      `[penaltyFeed] Final season ${options.season} has ${listedFixtures.length}/380 completed fixtures.`,
    );
  }
  const mappedFixtureCount = validateFixtureCoverage(
    listedFixtures,
    options.fplFixtures,
  );
  const fixtures = options.deep
    ? await fetchDeepFixtures(listedFixtures)
    : listedFixtures;
  const currentSources = options.deep
    ? null
    : (() => {
        const { bootstrap, footballers, fplFixtures } = options;
        if (!bootstrap || !footballers || !fplFixtures) {
          throw new Error(
            "[penaltyFeed] Current-season sync requires bootstrap, player histories, and FPL fixtures.",
          );
        }
        return { bootstrap, footballers, fplFixtures };
      })();
  const events = fixtures.flatMap((fixture) => fixture.goals);
  const playerCodes = await resolvePlayers(events);
  const validPlayerCodes = currentSources
    ? new Set(currentSources.bootstrap.elements.map((player) => player.code))
    : null;
  const records = new Map<string, PenaltyLedgerRow>();

  for (const fixture of fixtures) {
    for (const event of fixture.goals) {
      const playerCode = playerCodes.get(event.personId);
      if (!playerCode) {
        throw new Error(
          `[penaltyFeed] Failed to resolve player ${event.personId}.`,
        );
      }
      if (validPlayerCodes && !validPlayerCodes.has(playerCode)) {
        throw new Error(
          `[penaltyFeed] Opta player ${playerCode} did not join to an FPL player.`,
        );
      }
      const reconciledEvent = currentSources
        ? {
            ...event,
            teamId: resolveCurrentEventTeamId(
              event,
              fixture,
              playerCode,
              currentSources,
            ),
          }
        : event;
      addEvent(records, options.season, fixture, playerCode, reconciledEvent);
    }
  }

  if (currentSources) {
    addCurrentFplMisses(records, {
      season: options.season,
      ...currentSources,
    });
    validateCurrentScoredRows(
      records,
      currentSources.bootstrap,
      currentSources.footballers,
      currentSources.fplFixtures,
    );
  }

  const rows = [...records.values()];
  const scoredPenalties = rows.reduce((sum, row) => sum + row.scored, 0);
  const missedPenalties = rows.reduce((sum, row) => sum + row.missed, 0);

  await prisma.$transaction(async (tx) => {
    await tx.penalty_records.deleteMany({ where: { season: options.season } });
    await tx.penalty_fixtures.deleteMany({ where: { season: options.season } });
    await tx.penalty_fixture_players.deleteMany({
      where: { season: options.season },
    });
    if (fixtures.length > 0) {
      await tx.penalty_fixtures.createMany({
        data: fixtures.map((fixture) => ({
          season: options.season,
          fixture_code: fixture.fixtureCode,
          premier_league_id: fixture.id,
          gameweek: fixture.gameweek,
          home_team_pulse_id: fixture.homeTeamId,
          away_team_pulse_id: fixture.awayTeamId,
        })),
      });
    }
    const fixturePlayers = fixtures.flatMap((fixture) =>
      fixture.playerTeams.map((player) => ({
        season: options.season,
        fixture_code: fixture.fixtureCode,
        player_code: player.playerCode,
        team_pulse_id: player.teamId,
      })),
    );
    if (fixturePlayers.length > 0) {
      await tx.penalty_fixture_players.createMany({
        data: fixturePlayers,
        skipDuplicates: true,
      });
    }
    if (rows.length > 0) await tx.penalty_records.createMany({ data: rows });
    await tx.penalty_feed_sync.upsert({
      where: { season: options.season },
      update: {
        competition_season_id: competitionSeason.id,
        completed_fixture_count: listedFixtures.length,
        mapped_fixture_count: mappedFixtureCount,
        scored_penalties: scoredPenalties,
        missed_penalties: missedPenalties,
        deep_event_coverage: Boolean(options.deep),
        final_season: options.finalSeason,
        last_successful_refresh: new Date(),
      },
      create: {
        season: options.season,
        competition_season_id: competitionSeason.id,
        completed_fixture_count: listedFixtures.length,
        mapped_fixture_count: mappedFixtureCount,
        scored_penalties: scoredPenalties,
        missed_penalties: missedPenalties,
        deep_event_coverage: Boolean(options.deep),
        final_season: options.finalSeason,
        last_successful_refresh: new Date(),
      },
    });
  });

  return rows;
};
