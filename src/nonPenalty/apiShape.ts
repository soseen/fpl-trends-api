const requiredHistoryFields = [
  "penalties_scored",
  "non_penalty_goals_scored",
  "non_penalty_expected_goals",
  "non_penalty_expected_goal_involvements",
] as const;

const requiredAggregateFields = [
  ...requiredHistoryFields,
  "non_penalty_expected_goals_per_90",
  "non_penalty_expected_goal_involvements_per_90",
] as const;

const objectRows = (
  value: unknown,
  label: string,
): Record<string, unknown>[] => {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array.`);
  return value.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`${label}[${index}] is not an object.`);
    }
    return row as Record<string, unknown>;
  });
};

const assertFields = (
  row: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void => {
  const missing = fields.filter((field) => row[field] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `[nonPenalty] ${label} is missing ${missing.join(", ")}; run backfill-non-penalty.`,
    );
  }
};

export const assertFootballerAnalyticsShape = (
  value: unknown,
  label: string,
): void => {
  for (const [playerIndex, player] of objectRows(value, label).entries()) {
    assertFields(
      player,
      requiredAggregateFields,
      `${label} player ${playerIndex}`,
    );
    for (const [historyIndex, history] of objectRows(
      player["history"] ?? [],
      `${label} player ${playerIndex} history`,
    ).entries()) {
      assertFields(
        history,
        requiredHistoryFields,
        `${label} player ${playerIndex} history ${historyIndex}`,
      );
    }
    for (const [pastIndex, historyPast] of objectRows(
      player["history_past"] ?? [],
      `${label} player ${playerIndex} history_past`,
    ).entries()) {
      assertFields(
        historyPast,
        requiredAggregateFields,
        `${label} player ${playerIndex} history_past ${pastIndex}`,
      );
    }
  }
};

export const assertTeamAnalyticsShape = (
  value: unknown,
  label: string,
): void => {
  for (const [teamIndex, team] of objectRows(value, label).entries()) {
    for (const [historyIndex, history] of objectRows(
      team["team_history"] ?? [],
      `${label} team ${teamIndex} history`,
    ).entries()) {
      assertFields(
        history,
        ["teamNPXG", "teamNPXGA"],
        `${label} team ${teamIndex} history ${historyIndex}`,
      );
    }
  }
};
