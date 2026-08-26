import fs from "fs";
import {
  RAW_FOOTBALLERS_FILE,
  RAW_BOOTSTRAP_STATIC_FILE,
} from "../file.helpers.js";
import type { Footballer, FplFixture } from "../footballers/types.js";
import type { BootstrapStaticData } from "../bootstrapStatic/types.js";
import { prisma } from "./client.js";
import { calculateNonPenaltyStats, round2 } from "../nonPenalty/stats.js";
import { getPenaltyRecordMap, penaltyRecordKey } from "../penalties/ledger.js";

export const insertTeamHistory = async (
  season: string,
  fplFixtures: FplFixture[],
) => {
  // Load footballers JSON
  const footballersData: Record<string, Footballer> = fs.existsSync(
    RAW_FOOTBALLERS_FILE,
  )
    ? JSON.parse(fs.readFileSync(RAW_FOOTBALLERS_FILE, "utf8"))
    : {};

  // Load teams JSON from bootstrap static
  const bootstrapData: BootstrapStaticData = fs.existsSync(
    RAW_BOOTSTRAP_STATIC_FILE,
  )
    ? JSON.parse(fs.readFileSync(RAW_BOOTSTRAP_STATIC_FILE, "utf8"))
    : { teams: [], elements: [] };

  const footballerCodes = new Map<number, number>();
  for (const footballer of bootstrapData.elements) {
    footballerCodes.set(footballer.id, footballer.code);
  }
  const fixtures = new Map(fplFixtures.map((fixture) => [fixture.id, fixture]));
  const penalties = await getPenaltyRecordMap(season);

  type FixtureTeamStats = {
    round: number;
    teamXGC: number;
    teamXGS: number;
    teamNPXG: number;
    goals: number;
    goals_conceded: number;
  };
  const fixtureStats = new Map<number, Map<number, FixtureTeamStats>>();

  for (const [footballerIdStr, footballer] of Object.entries(footballersData)) {
    const footballerId = parseInt(footballerIdStr, 10);
    const playerCode = footballerCodes.get(footballerId);
    if (!playerCode)
      throw new Error(`Missing player code for ${footballerId}.`);

    for (const history of footballer.history ?? []) {
      const fixture = fixtures.get(history.fixture);
      if (!fixture) {
        throw new Error(`Missing FPL fixture ${history.fixture}.`);
      }
      const teamId = history.was_home ? fixture.team_h : fixture.team_a;
      let teams = fixtureStats.get(fixture.code);
      if (!teams) {
        teams = new Map();
        fixtureStats.set(fixture.code, teams);
      }
      if (!teams.has(teamId)) {
        teams.set(teamId, {
          round: history.round,
          teamXGC: 0,
          teamXGS: 0,
          teamNPXG: 0,
          goals: 0,
          goals_conceded: 0,
        });
      }
      const currentHistory = teams.get(teamId)!;
      currentHistory.teamXGC = Math.max(
        currentHistory.teamXGC,
        parseFloat(history.expected_goals_conceded) || 0,
      );
      currentHistory.teamXGS += parseFloat(history.expected_goals) || 0;
      const penalty = penalties.get(penaltyRecordKey(fixture.code, playerCode));
      const nonPenalty = calculateNonPenaltyStats({
        expectedGoals: history.expected_goals,
        expectedGoalInvolvements: history.expected_goal_involvements,
        goalsScored: history.goals_scored,
        penaltiesScored: penalty?.scored ?? 0,
        penaltiesMissed: history.penalties_missed,
      });
      if (nonPenalty.clamped) {
        console.warn(
          `[nonPenalty] Team aggregation clamped player ${playerCode}, fixture ${fixture.code}.`,
        );
      }
      currentHistory.teamNPXG += nonPenalty.non_penalty_expected_goals;
      currentHistory.goals += history.goals_scored || 0;
      currentHistory.goals_conceded = Math.max(
        currentHistory.goals_conceded,
        history.goals_conceded || 0,
      );
    }
  }

  type RoundStats = Omit<FixtureTeamStats, "round"> & { teamNPXGA: number };
  const roundStats = new Map<number, Map<number, RoundStats>>();
  for (const [fixtureCode, teams] of fixtureStats) {
    const fixture = fplFixtures.find((item) => item.code === fixtureCode);
    if (!fixture) throw new Error(`Missing fixture ${fixtureCode}.`);
    for (const teamId of [fixture.team_h, fixture.team_a]) {
      const own = teams.get(teamId) ?? {
        round: fixture.event ?? 0,
        teamXGC: 0,
        teamXGS: 0,
        teamNPXG: 0,
        goals: 0,
        goals_conceded: 0,
      };
      const opponentId =
        teamId === fixture.team_h ? fixture.team_a : fixture.team_h;
      const opponent = teams.get(opponentId);
      if (!roundStats.has(teamId)) roundStats.set(teamId, new Map());
      const rounds = roundStats.get(teamId)!;
      const aggregate = rounds.get(own.round) ?? {
        teamXGC: 0,
        teamXGS: 0,
        teamNPXG: 0,
        teamNPXGA: 0,
        goals: 0,
        goals_conceded: 0,
      };
      aggregate.teamXGC += own.teamXGC;
      aggregate.teamXGS += own.teamXGS;
      aggregate.teamNPXG += own.teamNPXG;
      aggregate.teamNPXGA += opponent?.teamNPXG ?? 0;
      aggregate.goals += own.goals;
      aggregate.goals_conceded += own.goals_conceded;
      rounds.set(own.round, aggregate);
    }
  }

  for (const [teamId, rounds] of roundStats) {
    for (const [round, history] of rounds) {
      const rounded = {
        ...history,
        teamXGC: round2(history.teamXGC),
        teamXGS: round2(history.teamXGS),
        teamNPXG: round2(history.teamNPXG),
        teamNPXGA: round2(history.teamNPXGA),
      };
      await prisma.team_history.upsert({
        where: { team_id_round: { team_id: teamId, round } },
        update: rounded,
        create: { team_id: teamId, round, ...rounded },
      });
    }
  }

  console.info("Team history data populated successfully.");
};
