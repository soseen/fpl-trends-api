export const PENALTY_EXPECTED_GOALS = 0.79;

export type NonPenaltyInput = {
  expectedGoals: string | number | null | undefined;
  expectedGoalInvolvements: string | number | null | undefined;
  goalsScored: number | null | undefined;
  penaltiesScored: number | null | undefined;
  penaltiesMissed: number | null | undefined;
};

export type NonPenaltyStats = {
  penalties_scored: number;
  non_penalty_goals_scored: number;
  non_penalty_expected_goals: number;
  non_penalty_expected_goal_involvements: number;
  clamped: boolean;
};

export const round2 = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;

export const calculateNonPenaltyFinishing = (
  nonPenaltyGoals: number,
  nonPenaltyExpectedGoals: number,
): number => round2(nonPenaltyGoals - nonPenaltyExpectedGoals);

const numeric = (value: string | number | null | undefined): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const calculateNonPenaltyStats = (
  input: NonPenaltyInput,
): NonPenaltyStats => {
  const penaltiesScored = Math.max(0, Math.trunc(input.penaltiesScored ?? 0));
  const penaltiesMissed = Math.max(0, Math.trunc(input.penaltiesMissed ?? 0));
  const attempts = penaltiesScored + penaltiesMissed;
  const adjustedGoals = round2(
    numeric(input.expectedGoals) - PENALTY_EXPECTED_GOALS * attempts,
  );
  const adjustedInvolvements = round2(
    numeric(input.expectedGoalInvolvements) - PENALTY_EXPECTED_GOALS * attempts,
  );
  const nonPenaltyGoals = (input.goalsScored ?? 0) - penaltiesScored;

  return {
    penalties_scored: penaltiesScored,
    non_penalty_goals_scored: Math.max(0, nonPenaltyGoals),
    non_penalty_expected_goals: Math.max(0, adjustedGoals),
    non_penalty_expected_goal_involvements: Math.max(0, adjustedInvolvements),
    clamped:
      adjustedGoals < 0 || adjustedInvolvements < 0 || nonPenaltyGoals < 0,
  };
};

export const withNonPenaltyStats = <
  T extends {
    expected_goals?: string | number | null;
    expected_goal_involvements?: string | number | null;
    goals_scored?: number | null;
    penalties_scored?: number | null;
    penalties_missed?: number | null;
  },
>(
  row: T,
  context?: string,
): T & Omit<NonPenaltyStats, "clamped"> => {
  const { clamped, ...stats } = calculateNonPenaltyStats({
    expectedGoals: row.expected_goals,
    expectedGoalInvolvements: row.expected_goal_involvements,
    goalsScored: row.goals_scored,
    penaltiesScored: row.penalties_scored,
    penaltiesMissed: row.penalties_missed,
  });

  if (clamped) {
    console.warn(
      `[nonPenalty] Clamped reconciled values${context ? ` for ${context}` : ""}; check source rounding and penalty mappings.`,
    );
  }

  return { ...row, ...stats };
};
