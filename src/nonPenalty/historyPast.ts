import { calculateNonPenaltyStats, round2 } from "./stats.js";
import { normalizeSeasonLabel } from "../penalties/premierLeagueFeed.js";
import type { PlayerSeasonPenaltyTotals } from "../penalties/ledger.js";

type HistoryPastSource = {
  season_name?: unknown;
  minutes?: unknown;
  goals_scored?: unknown;
  penalties_missed?: unknown;
  expected_goals?: unknown;
  expected_goal_involvements?: unknown;
  [key: string]: unknown;
};

export type EnrichedHistoryPast = HistoryPastSource & {
  penalties_scored: number;
  non_penalty_goals_scored: number;
  non_penalty_expected_goals: number;
  non_penalty_expected_goal_involvements: number;
  non_penalty_expected_goals_per_90: number;
  non_penalty_expected_goal_involvements_per_90: number;
};

export const enrichHistoryPast = (
  row: HistoryPastSource,
  playerCode: number,
  totals: Map<string, PlayerSeasonPenaltyTotals>,
  deepCoveredSeasons: Set<string>,
): EnrichedHistoryPast => {
  const season = normalizeSeasonLabel(row.season_name);
  if (!season) {
    throw new Error(
      `[nonPenalty] Invalid history_past season label ${String(row.season_name)} for player ${playerCode}.`,
    );
  }
  const hasExpectedData =
    row.expected_goals !== undefined ||
    row.expected_goal_involvements !== undefined;
  if (hasExpectedData && !deepCoveredSeasons.has(season)) {
    throw new Error(
      `[nonPenalty] Missing full penalty-event coverage for history_past ${season}, player ${playerCode}. Run backfill-non-penalty first.`,
    );
  }
  const penalties = totals.get(`${season}:${playerCode}`) ?? {
    scored: 0,
    missed: 0,
  };
  if (
    hasExpectedData &&
    row.penalties_missed !== undefined &&
    Number(row.penalties_missed) !== penalties.missed
  ) {
    throw new Error(
      `[nonPenalty] history_past miss mismatch for ${season}, player ${playerCode}.`,
    );
  }
  const stats = calculateNonPenaltyStats({
    expectedGoals: Number(row.expected_goals ?? 0),
    expectedGoalInvolvements: Number(row.expected_goal_involvements ?? 0),
    goalsScored: Number(row.goals_scored ?? 0),
    penaltiesScored: penalties.scored,
    penaltiesMissed: penalties.missed,
  });
  if (stats.clamped) {
    console.warn(
      `[nonPenalty] Clamped history_past ${season}, player ${playerCode}; check source reconciliation.`,
    );
  }
  const minutes = Number(row.minutes ?? 0);
  const per90 = (value: number): number =>
    minutes > 0 ? round2((value * 90) / minutes) : 0;

  return {
    ...row,
    penalties_missed: penalties.missed,
    penalties_scored: stats.penalties_scored,
    non_penalty_goals_scored: stats.non_penalty_goals_scored,
    non_penalty_expected_goals: stats.non_penalty_expected_goals,
    non_penalty_expected_goal_involvements:
      stats.non_penalty_expected_goal_involvements,
    non_penalty_expected_goals_per_90: per90(stats.non_penalty_expected_goals),
    non_penalty_expected_goal_involvements_per_90: per90(
      stats.non_penalty_expected_goal_involvements,
    ),
  };
};
