import fs from "fs";
import { prisma } from "./client.js";
import {
  RAW_BOOTSTRAP_STATIC_FILE,
  RAW_FOOTBALLERS_FILE,
} from "../file.helpers.js";
import type { Footballer, FplFixture } from "../footballers/types.js";
import type { BootstrapStaticData } from "../bootstrapStatic/types.js";
import { getPenaltyRecordMap, penaltyRecordKey } from "../penalties/ledger.js";

export const insertFootballersHistory = async (
  season: string,
  fplFixtures: FplFixture[],
) => {
  const rawData: Record<string, Footballer> = fs.existsSync(
    RAW_FOOTBALLERS_FILE,
  )
    ? JSON.parse(fs.readFileSync(RAW_FOOTBALLERS_FILE, "utf8"))
    : {};

  const existingFootballers = await prisma.footballers.findMany({
    select: { id: true },
  });

  const existingFootballerIds = new Set(existingFootballers.map((f) => f.id));
  const bootstrapData = JSON.parse(
    fs.readFileSync(RAW_BOOTSTRAP_STATIC_FILE, "utf8"),
  ) as BootstrapStaticData;
  const playerCodes = new Map(
    bootstrapData.elements.map((player) => [player.id, player.code]),
  );
  const fixtureCodes = new Map(
    fplFixtures.map((fixture) => [fixture.id, fixture.code]),
  );
  const penaltyRecords = await getPenaltyRecordMap(season);

  for (const [footballerId, footballer] of Object.entries(rawData)) {
    const parsedFootballerId = parseInt(footballerId, 10);

    if (!existingFootballerIds.has(parsedFootballerId)) {
      console.warn(
        `Skipping history for footballer_id=${parsedFootballerId} (not found in DB)`,
      );
      continue;
    }

    const playerCode = playerCodes.get(parsedFootballerId);
    if (!playerCode) {
      throw new Error(
        `Missing player code for FPL element ${parsedFootballerId}.`,
      );
    }

    for (const historyEntry of footballer.history) {
      const fixtureCode = fixtureCodes.get(historyEntry.fixture);
      if (!fixtureCode) {
        throw new Error(
          `Missing fixture code for FPL fixture ${historyEntry.fixture}.`,
        );
      }
      const penalty = penaltyRecords.get(
        penaltyRecordKey(fixtureCode, playerCode),
      );
      if ((penalty?.missed ?? 0) !== historyEntry.penalties_missed) {
        throw new Error(
          `Penalty miss mismatch for player ${playerCode}, fixture ${fixtureCode}: ledger=${penalty?.missed ?? 0}, FPL=${historyEntry.penalties_missed}.`,
        );
      }
      await prisma.history.upsert({
        where: {
          footballer_id_fixture_id: {
            footballer_id: parsedFootballerId,
            fixture_id: historyEntry.fixture,
          },
        },
        update: {
          opponent_team: historyEntry.opponent_team,
          total_points: historyEntry.total_points,
          was_home: historyEntry.was_home,
          kickoff_time: new Date(historyEntry.kickoff_time),
          team_h_score: historyEntry.team_h_score,
          team_a_score: historyEntry.team_a_score,
          round: historyEntry.round,
          modified: historyEntry.modified,
          minutes: historyEntry.minutes,
          goals_scored: historyEntry.goals_scored,
          assists: historyEntry.assists,
          clean_sheets: historyEntry.clean_sheets,
          goals_conceded: historyEntry.goals_conceded,
          own_goals: historyEntry.own_goals,
          penalties_saved: historyEntry.penalties_saved,
          penalties_missed: historyEntry.penalties_missed,
          penalties_scored: penalty?.scored ?? 0,
          fixture_code: fixtureCode,
          yellow_cards: historyEntry.yellow_cards,
          red_cards: historyEntry.red_cards,
          saves: historyEntry.saves,
          bonus: historyEntry.bonus,
          bps: historyEntry.bps,
          influence: historyEntry.influence,
          creativity: historyEntry.creativity,
          threat: historyEntry.threat,
          ict_index: historyEntry.ict_index,
          starts: historyEntry.starts,
          expected_goals: historyEntry.expected_goals,
          expected_assists: historyEntry.expected_assists,
          expected_goal_involvements: historyEntry.expected_goal_involvements,
          expected_goals_conceded: historyEntry.expected_goals_conceded,
          value: historyEntry.value,
          transfers_balance: historyEntry.transfers_balance,
          selected: historyEntry.selected,
          transfers_in: historyEntry.transfers_in,
          transfers_out: historyEntry.transfers_out,
          defensive_contribution: historyEntry.defensive_contribution ?? null,
        },
        create: {
          footballer_id: parsedFootballerId,
          fixture_id: historyEntry.fixture,
          opponent_team: historyEntry.opponent_team,
          total_points: historyEntry.total_points,
          was_home: historyEntry.was_home,
          kickoff_time: new Date(historyEntry.kickoff_time),
          team_h_score: historyEntry.team_h_score,
          team_a_score: historyEntry.team_a_score,
          round: historyEntry.round,
          modified: historyEntry.modified,
          minutes: historyEntry.minutes,
          goals_scored: historyEntry.goals_scored,
          assists: historyEntry.assists,
          clean_sheets: historyEntry.clean_sheets,
          goals_conceded: historyEntry.goals_conceded,
          own_goals: historyEntry.own_goals,
          penalties_saved: historyEntry.penalties_saved,
          penalties_missed: historyEntry.penalties_missed,
          penalties_scored: penalty?.scored ?? 0,
          fixture_code: fixtureCode,
          yellow_cards: historyEntry.yellow_cards,
          red_cards: historyEntry.red_cards,
          saves: historyEntry.saves,
          bonus: historyEntry.bonus,
          bps: historyEntry.bps,
          influence: historyEntry.influence,
          creativity: historyEntry.creativity,
          threat: historyEntry.threat,
          ict_index: historyEntry.ict_index,
          starts: historyEntry.starts,
          expected_goals: historyEntry.expected_goals,
          expected_assists: historyEntry.expected_assists,
          expected_goal_involvements: historyEntry.expected_goal_involvements,
          expected_goals_conceded: historyEntry.expected_goals_conceded,
          value: historyEntry.value,
          transfers_balance: historyEntry.transfers_balance,
          selected: historyEntry.selected,
          transfers_in: historyEntry.transfers_in,
          transfers_out: historyEntry.transfers_out,
          defensive_contribution: historyEntry.defensive_contribution ?? null,
        },
      });
    }
  }
};
