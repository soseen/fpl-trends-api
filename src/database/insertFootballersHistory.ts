import fs from "fs";
import { prisma } from "./client.js";
import { RAW_FOOTBALLERS_FILE } from "../file.helpers.js";
import type { Footballer } from "../footballers/types.js";

export const insertFootballersHistory = async () => {
  try {
    const rawData: Record<string, Footballer> = fs.existsSync(
      RAW_FOOTBALLERS_FILE,
    )
      ? JSON.parse(fs.readFileSync(RAW_FOOTBALLERS_FILE, "utf8"))
      : {};

    const existingFootballers = await prisma.footballers.findMany({
      select: { id: true },
    });

    const existingFootballerIds = new Set(existingFootballers.map((f) => f.id));

    for (const [footballerId, footballer] of Object.entries(rawData)) {
      const parsedFootballerId = parseInt(footballerId, 10);

      if (!existingFootballerIds.has(parsedFootballerId)) {
        console.warn(
          `Skipping history for footballer_id=${parsedFootballerId} (not found in DB)`,
        );
        continue;
      }

      for (const historyEntry of footballer.history) {
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
          },
        });
      }
    }
  } catch (error) {
    console.error(
      "Couldn't populate the history table. Error:",
      (error as Error)?.message,
    );
  } finally {
    await prisma.$disconnect();
  }
};
