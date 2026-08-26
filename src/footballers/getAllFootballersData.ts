import { prisma } from "../database/client.js";
import { round2, withNonPenaltyStats } from "../nonPenalty/stats.js";
import { assertCurrentPenaltyFeedReady } from "../penalties/readiness.js";

type HistoryPastApiRow = {
  penalties_scored?: unknown;
  non_penalty_goals_scored?: unknown;
  non_penalty_expected_goals?: unknown;
  non_penalty_expected_goal_involvements?: unknown;
  non_penalty_expected_goals_per_90?: unknown;
  non_penalty_expected_goal_involvements_per_90?: unknown;
  [key: string]: unknown;
};

const assertHistoryPastShape = (
  value: unknown,
  playerCode: number | null,
): HistoryPastApiRow[] => {
  if (!Array.isArray(value)) return [];
  const required = [
    "penalties_scored",
    "non_penalty_goals_scored",
    "non_penalty_expected_goals",
    "non_penalty_expected_goal_involvements",
    "non_penalty_expected_goals_per_90",
    "non_penalty_expected_goal_involvements_per_90",
  ];
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(
        `Invalid history_past row for player ${playerCode ?? "unknown"}.`,
      );
    }
    const row = item as HistoryPastApiRow;
    const missing = required.filter((key) => row[key] === undefined);
    if (missing.length > 0) {
      throw new Error(
        `Missing non-penalty history_past fields for player ${playerCode ?? "unknown"}: ${missing.join(", ")}. Run backfill-non-penalty.`,
      );
    }
    return row;
  });
};

export const getFootballersWithHistoryAndFixtures = async () => {
  await assertCurrentPenaltyFeedReady();
  const footballers = await prisma.footballers.findMany({
    select: {
      id: true,
      code: true,
      web_name: true,
      first_name: true,
      second_name: true,
      team_id: true,
      team_code: true,
      team: true,
      element_type: true,
      now_cost: true,
      total_points: true,
      points_per_game: true,
      selected_by_percent: true,
      status: true,
      chance_of_playing_next_round: true,
      transfers_in_event: true,
      transfers_out_event: true,
      in_dreamteam: true,
      photo: true,
      minutes: true,
      goals_scored: true,
      assists: true,
      bonus: true,
      clean_sheets: true,
      penalties_missed: true,
      expected_goals_per_90: true,
      expected_goals: true,
      expected_assists_per_90: true,
      expected_assists: true,
      expected_goal_involvements_per_90: true,
      expected_goal_involvements: true,
      expected_goals_conceded_per_90: true,
      defensive_contribution: true,
      defensive_contribution_per_90: true,
      history_past: true,
      teams: {
        select: {
          id: true,
          name: true,
          short_name: true,
          code: true,
        },
      },
      history: {
        orderBy: { round: "asc" },
        select: {
          round: true,
          total_points: true,
          minutes: true,
          goals_scored: true,
          penalties_missed: true,
          penalties_scored: true,
          assists: true,
          bonus: true,
          clean_sheets: true,
          saves: true,
          team_a_score: true,
          team_h_score: true,
          was_home: true,
          selected: true,
          opponent_team: true,
          expected_goal_involvements: true,
          expected_goals: true,
          expected_assists: true,
          expected_goals_conceded: true,
          fixture_code: true,
          defensive_contribution: true,
        },
      },
      footballer_fixtures: {
        orderBy: { event: "asc" },
        select: {
          event: true,
          is_home: true,
          team_h: true,
          team_a: true,
          difficulty: true,
          kickoff_time: true,
        },
      },
    },
  });

  return footballers.map((footballer) => {
    const history = footballer.history.map((row) => {
      if (row.fixture_code === null) {
        throw new Error(
          `[nonPenalty] Player ${footballer.code ?? footballer.id} has history without an Opta fixture join. Run backfill-non-penalty.`,
        );
      }
      return withNonPenaltyStats(
        row,
        `player ${footballer.code ?? footballer.id}, fixture ${row.fixture_code}`,
      );
    });
    const totals = history.reduce(
      (sum, row) => ({
        penaltiesScored: sum.penaltiesScored + row.penalties_scored,
        nonPenaltyGoals: sum.nonPenaltyGoals + row.non_penalty_goals_scored,
        npxG: sum.npxG + row.non_penalty_expected_goals,
        npxGI: sum.npxGI + row.non_penalty_expected_goal_involvements,
        minutes: sum.minutes + row.minutes,
      }),
      {
        penaltiesScored: 0,
        nonPenaltyGoals: 0,
        npxG: 0,
        npxGI: 0,
        minutes: 0,
      },
    );
    const per90 = (value: number): number =>
      totals.minutes > 0 ? round2((value * 90) / totals.minutes) : 0;

    return {
      ...footballer,
      history_past: assertHistoryPastShape(
        footballer.history_past,
        footballer.code,
      ),
      history,
      penalties_scored: totals.penaltiesScored,
      non_penalty_goals_scored: totals.nonPenaltyGoals,
      non_penalty_expected_goals: round2(totals.npxG),
      non_penalty_expected_goal_involvements: round2(totals.npxGI),
      non_penalty_expected_goals_per_90: per90(totals.npxG),
      non_penalty_expected_goal_involvements_per_90: per90(totals.npxGI),
    };
  });
};
