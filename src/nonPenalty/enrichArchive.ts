import type {
  penalty_fixture_players,
  penalty_fixtures,
  penalty_records,
} from "@prisma/client";
import {
  penaltyRecordKey,
  type PlayerSeasonPenaltyTotals,
} from "../penalties/ledger.js";
import { enrichHistoryPast } from "./historyPast.js";
import { round2, withNonPenaltyStats } from "./stats.js";

type JsonRow = Record<string, unknown>;

const rows = (value: unknown, label: string): JsonRow[] => {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array.`);
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${label} contains a non-object row.`);
    }
    return item as JsonRow;
  });
};

const number = (value: unknown, label: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not numeric.`);
  return parsed;
};

const boolean = (value: unknown, label: string): boolean => {
  if (typeof value !== "boolean") throw new Error(`${label} is not boolean.`);
  return value;
};

export type ArchiveEnrichmentInput = {
  season: string;
  footballers: unknown;
  teams: unknown;
  fixtures: penalty_fixtures[];
  penaltyRecords: penalty_records[];
  fixturePlayers: penalty_fixture_players[];
  penaltyTotals: Map<string, PlayerSeasonPenaltyTotals>;
  deepCoveredSeasons: Set<string>;
};

export type ArchiveEnrichmentResult = {
  footballers: JsonRow[];
  teams: JsonRow[];
};

export const enrichArchive = (
  input: ArchiveEnrichmentInput,
): ArchiveEnrichmentResult => {
  const footballers = rows(input.footballers, `${input.season} footballers`);
  const teams = rows(input.teams, `${input.season} teams`);
  const pulseByTeamId = new Map(
    teams.map((team) => [
      number(team["id"], "team id"),
      number(team["pulse_id"], "team pulse_id"),
    ]),
  );
  const teamIdByPulse = new Map(
    [...pulseByTeamId].map(([teamId, pulseId]) => [pulseId, teamId]),
  );
  const fixturesByRound = new Map<number, penalty_fixtures[]>();
  for (const fixture of input.fixtures) {
    if (fixture.gameweek === null) continue;
    const roundFixtures = fixturesByRound.get(fixture.gameweek) ?? [];
    roundFixtures.push(fixture);
    fixturesByRound.set(fixture.gameweek, roundFixtures);
  }
  const records = new Map(
    input.penaltyRecords.map((record) => [
      penaltyRecordKey(record.fixture_code, record.player_code),
      record,
    ]),
  );
  const fixturePlayers = new Set(
    input.fixturePlayers.map(
      (player) => `${player.fixture_code}:${player.player_code}`,
    ),
  );

  type FixtureTeam = { round: number; npxG: number };
  const fixtureTeamStats = new Map<string, FixtureTeam>();

  const enrichedFootballers = footballers.map((footballer) => {
    const playerCode = number(footballer["code"], "footballer code");
    const history = rows(
      footballer["history"] ?? [],
      `${input.season} player ${playerCode} history`,
    ).map((historyRow) => {
      const round = number(historyRow["round"], "history round");
      const opponentTeamId = number(
        historyRow["opponent_team"],
        "history opponent_team",
      );
      const opponentPulseId = pulseByTeamId.get(opponentTeamId);
      const wasHome = boolean(historyRow["was_home"], "history was_home");
      if (!opponentPulseId) {
        throw new Error(
          `${input.season} player ${playerCode} has no opponent Pulse mapping in GW${round}.`,
        );
      }
      let matches = (fixturesByRound.get(round) ?? []).filter((fixture) =>
        wasHome
          ? fixture.away_team_pulse_id === opponentPulseId
          : fixture.home_team_pulse_id === opponentPulseId,
      );
      if (matches.length > 1) {
        const playerMatches = matches.filter((fixture) =>
          fixturePlayers.has(`${fixture.fixture_code}:${playerCode}`),
        );
        const penaltyMatches = matches.filter((fixture) =>
          records.has(penaltyRecordKey(fixture.fixture_code, playerCode)),
        );
        if (playerMatches.length === 1) matches = playerMatches;
        else if (penaltyMatches.length === 1) matches = penaltyMatches;
      }
      if (matches.length !== 1 || !matches[0]) {
        throw new Error(
          `${input.season} player ${playerCode} GW${round} matched ${matches.length} official fixtures.`,
        );
      }
      const fixture = matches[0];
      const penalty = records.get(
        penaltyRecordKey(fixture.fixture_code, playerCode),
      );
      const enriched = withNonPenaltyStats(
        {
          ...historyRow,
          fixture_code: fixture.fixture_code,
          penalties_scored: penalty?.scored ?? 0,
          penalties_missed: penalty?.missed ?? 0,
        },
        `${input.season} player ${playerCode}, fixture ${fixture.fixture_code}`,
      );
      const ownPulseId = wasHome
        ? fixture.home_team_pulse_id
        : fixture.away_team_pulse_id;
      const teamId = teamIdByPulse.get(ownPulseId);
      if (!teamId) {
        throw new Error(
          `${input.season} fixture ${fixture.fixture_code} has no FPL team mapping.`,
        );
      }
      const key = `${fixture.fixture_code}:${teamId}`;
      const fixtureTeam = fixtureTeamStats.get(key) ?? { round, npxG: 0 };
      fixtureTeam.npxG += enriched.non_penalty_expected_goals;
      fixtureTeamStats.set(key, fixtureTeam);
      return enriched;
    });

    const totals = history.reduce(
      (sum, historyRow) => ({
        penaltiesScored:
          sum.penaltiesScored +
          number(historyRow.penalties_scored, "penalties_scored"),
        nonPenaltyGoals:
          sum.nonPenaltyGoals +
          number(
            historyRow.non_penalty_goals_scored,
            "non_penalty_goals_scored",
          ),
        npxG:
          sum.npxG +
          number(
            historyRow.non_penalty_expected_goals,
            "non_penalty_expected_goals",
          ),
        npxGI:
          sum.npxGI +
          number(
            historyRow.non_penalty_expected_goal_involvements,
            "non_penalty_expected_goal_involvements",
          ),
        minutes:
          sum.minutes +
          number((historyRow as JsonRow)["minutes"] ?? 0, "minutes"),
      }),
      { penaltiesScored: 0, nonPenaltyGoals: 0, npxG: 0, npxGI: 0, minutes: 0 },
    );
    const per90 = (value: number): number =>
      totals.minutes > 0 ? round2((value * 90) / totals.minutes) : 0;
    const historyPast = rows(
      footballer["history_past"] ?? [],
      `${input.season} player ${playerCode} history_past`,
    ).map((row) =>
      enrichHistoryPast(
        row,
        playerCode,
        input.penaltyTotals,
        input.deepCoveredSeasons,
      ),
    );

    return {
      ...footballer,
      history,
      history_past: historyPast,
      penalties_scored: totals.penaltiesScored,
      non_penalty_goals_scored: totals.nonPenaltyGoals,
      non_penalty_expected_goals: round2(totals.npxG),
      non_penalty_expected_goal_involvements: round2(totals.npxGI),
      non_penalty_expected_goals_per_90: per90(totals.npxG),
      non_penalty_expected_goal_involvements_per_90: per90(totals.npxGI),
    };
  });

  const roundTeamStats = new Map<string, { npxG: number; npxGA: number }>();
  for (const fixture of input.fixtures) {
    if (fixture.gameweek === null) continue;
    const homeTeamId = teamIdByPulse.get(fixture.home_team_pulse_id);
    const awayTeamId = teamIdByPulse.get(fixture.away_team_pulse_id);
    if (!homeTeamId || !awayTeamId) {
      throw new Error(
        `${input.season} fixture ${fixture.fixture_code} does not map to both FPL teams.`,
      );
    }
    const homeNpxG =
      fixtureTeamStats.get(`${fixture.fixture_code}:${homeTeamId}`)?.npxG ?? 0;
    const awayNpxG =
      fixtureTeamStats.get(`${fixture.fixture_code}:${awayTeamId}`)?.npxG ?? 0;
    for (const [teamId, npxG, npxGA] of [
      [homeTeamId, homeNpxG, awayNpxG],
      [awayTeamId, awayNpxG, homeNpxG],
    ] as const) {
      const key = `${teamId}:${fixture.gameweek}`;
      const aggregate = roundTeamStats.get(key) ?? { npxG: 0, npxGA: 0 };
      aggregate.npxG += npxG;
      aggregate.npxGA += npxGA;
      roundTeamStats.set(key, aggregate);
    }
  }

  const enrichedTeams = teams.map((team) => {
    const teamId = number(team["id"], "team id");
    const history = rows(
      team["team_history"] ?? [],
      `${input.season} team ${teamId} history`,
    ).map((historyRow) => {
      const round = number(historyRow["round"], "team history round");
      const aggregate = roundTeamStats.get(`${teamId}:${round}`) ?? {
        npxG: 0,
        npxGA: 0,
      };
      return {
        ...historyRow,
        teamNPXG: round2(aggregate.npxG),
        teamNPXGA: round2(aggregate.npxGA),
      };
    });
    return { ...team, team_history: history };
  });

  return { footballers: enrichedFootballers, teams: enrichedTeams };
};
