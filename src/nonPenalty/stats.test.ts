import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calculateNonPenaltyFinishing,
  calculateNonPenaltyStats,
} from "./stats.js";

const calculate = (
  expectedGoals: number,
  expectedGoalInvolvements: number,
  penaltiesScored = 0,
  penaltiesMissed = 0,
  goalsScored = 0,
) =>
  calculateNonPenaltyStats({
    expectedGoals,
    expectedGoalInvolvements,
    goalsScored,
    penaltiesScored,
    penaltiesMissed,
  });

void describe("calculateNonPenaltyStats", () => {
  void it("leaves an open-play row unchanged and rounds to two decimals", () => {
    assert.deepEqual(calculate(1.234, 1.456), {
      penalties_scored: 0,
      non_penalty_goals_scored: 0,
      non_penalty_expected_goals: 1.23,
      non_penalty_expected_goal_involvements: 1.46,
      clamped: false,
    });
  });

  void it("removes a scored or missed penalty", () => {
    assert.equal(calculate(0.79, 0.79, 1, 0, 1).non_penalty_expected_goals, 0);
    assert.equal(calculate(0.79, 0.79, 0, 1).non_penalty_expected_goals, 0);
  });

  void it("handles mixed xG and two attempts in one match", () => {
    const mixed = calculate(1.29, 1.69, 1, 0, 2);
    assert.equal(mixed.non_penalty_expected_goals, 0.5);
    assert.equal(mixed.non_penalty_expected_goal_involvements, 0.9);
    assert.equal(mixed.non_penalty_goals_scored, 1);
    assert.equal(
      mixed.non_penalty_expected_goal_involvements -
        mixed.non_penalty_expected_goals,
      0.4,
      "xA must remain unchanged",
    );
    assert.equal(calculate(1.58, 1.58, 2).non_penalty_expected_goals, 0);
  });

  void it("flags source-rounding drift when clamping", () => {
    const result = calculate(0.78, 0.78, 1);
    assert.equal(result.non_penalty_expected_goals, 0);
    assert.equal(result.clamped, true);
  });

  void it("evaluates finishing with non-penalty goals", () => {
    assert.equal(calculateNonPenaltyFinishing(3, 2.41), 0.59);
  });
});
