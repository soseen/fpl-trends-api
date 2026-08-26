import "dotenv/config";
import { fileURLToPath } from "node:url";
import { calculateNonPenaltyStats, round2 } from "../nonPenalty/stats.js";
import { penaltyRecordKey } from "../penalties/ledger.js";
import { prisma } from "./client.js";
import { getStoredSeason } from "./seasonManager.js";

const EPSILON = 0.011;
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

const assertClose = (actual: number, expected: number, label: string): void => {
  if (Math.abs(actual - expected) > EPSILON) {
    throw new Error(`${label}: expected ${expected}, received ${actual}.`);
  }
};

const assertFields = (
  value: unknown,
  fields: readonly string[],
  label: string,
): void => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object.`);
  }
  const row = value as Record<string, unknown>;
  const missing = fields.filter((field) => row[field] === undefined);
  if (missing.length > 0) {
    throw new Error(`${label} is missing ${missing.join(", ")}.`);
  }
};

export const checkNonPenaltyIntegrity = async (): Promise<void> => {
  const season = await getStoredSeason();
  if (!season) throw new Error("No current season is stored.");
  const sync = await prisma.penalty_feed_sync.findUnique({ where: { season } });
  if (!sync) throw new Error(`No penalty-feed metadata exists for ${season}.`);
  if (sync.completed_fixture_count !== sync.mapped_fixture_count) {
    throw new Error(
      `Penalty-feed fixture coverage is incomplete for ${season}.`,
    );
  }

  const [histories, records, fixtures, teams, teamHistory, archives] =
    await Promise.all([
      prisma.history.findMany({
        include: { footballer: { select: { code: true } } },
      }),
      prisma.penalty_records.findMany({ where: { season } }),
      prisma.penalty_fixtures.findMany({ where: { season } }),
      prisma.teams.findMany({ select: { id: true, pulse_id: true } }),
      prisma.team_history.findMany(),
      prisma.season_archives.findMany({
        select: { season: true, footballers_data: true, teams_data: true },
      }),
    ]);
  const recordMap = new Map(
    records.map((record) => [
      penaltyRecordKey(record.fixture_code, record.player_code),
      record,
    ]),
  );
  const fixtureMap = new Map(
    fixtures.map((fixture) => [fixture.fixture_code, fixture]),
  );
  const teamByPulse = new Map(
    teams
      .filter((team) => team.pulse_id !== null)
      .map((team) => [team.pulse_id!, team.id]),
  );
  const fixtureTeamNpxG = new Map<string, number>();

  for (const history of histories) {
    if (!history.fixture_code || !history.footballer.code) {
      throw new Error(
        `History ${history.footballer_id}:${history.fixture_id} lacks an exact Opta join.`,
      );
    }
    const penalty = recordMap.get(
      penaltyRecordKey(history.fixture_code, history.footballer.code),
    );
    if (
      history.penalties_scored !== (penalty?.scored ?? 0) ||
      history.penalties_missed !== (penalty?.missed ?? 0)
    ) {
      throw new Error(
        `Penalty ledger mismatch for ${history.footballer.code}:${history.fixture_code}.`,
      );
    }
    const stats = calculateNonPenaltyStats({
      expectedGoals: history.expected_goals,
      expectedGoalInvolvements: history.expected_goal_involvements,
      goalsScored: history.goals_scored,
      penaltiesScored: history.penalties_scored,
      penaltiesMissed: history.penalties_missed,
    });
    if (stats.clamped) {
      throw new Error(
        `Clamping is required for ${history.footballer.code}:${history.fixture_code}.`,
      );
    }
    const fixture = fixtureMap.get(history.fixture_code);
    if (!fixture) throw new Error(`Missing fixture ${history.fixture_code}.`);
    const pulseId = history.was_home
      ? fixture.home_team_pulse_id
      : fixture.away_team_pulse_id;
    const teamId = teamByPulse.get(pulseId);
    if (!teamId) throw new Error(`Missing team mapping for Pulse ${pulseId}.`);
    const key = `${history.fixture_code}:${teamId}`;
    fixtureTeamNpxG.set(
      key,
      (fixtureTeamNpxG.get(key) ?? 0) + stats.non_penalty_expected_goals,
    );
  }

  const expectedRounds = new Map<string, { npxG: number; npxGA: number }>();
  for (const fixture of fixtures) {
    if (fixture.gameweek === null) continue;
    const homeId = teamByPulse.get(fixture.home_team_pulse_id);
    const awayId = teamByPulse.get(fixture.away_team_pulse_id);
    if (!homeId || !awayId) continue;
    const home = fixtureTeamNpxG.get(`${fixture.fixture_code}:${homeId}`) ?? 0;
    const away = fixtureTeamNpxG.get(`${fixture.fixture_code}:${awayId}`) ?? 0;
    for (const [teamId, npxG, npxGA] of [
      [homeId, home, away],
      [awayId, away, home],
    ] as const) {
      const key = `${teamId}:${fixture.gameweek}`;
      const aggregate = expectedRounds.get(key) ?? { npxG: 0, npxGA: 0 };
      aggregate.npxG += npxG;
      aggregate.npxGA += npxGA;
      expectedRounds.set(key, aggregate);
    }
  }
  for (const row of teamHistory) {
    const expected = expectedRounds.get(`${row.team_id}:${row.round}`);
    if (!expected) continue;
    assertClose(row.teamNPXG, round2(expected.npxG), "teamNPXG invariant");
    assertClose(row.teamNPXGA, round2(expected.npxGA), "teamNPXGA invariant");
  }

  for (const archive of archives) {
    if (!Array.isArray(archive.footballers_data)) {
      throw new Error(`${archive.season} footballers archive is invalid.`);
    }
    for (const [index, value] of archive.footballers_data.entries()) {
      assertFields(
        value,
        requiredAggregateFields,
        `${archive.season} player ${index}`,
      );
      const player = value as Record<string, unknown>;
      for (const [historyIndex, history] of (Array.isArray(player["history"])
        ? player["history"]
        : []
      ).entries()) {
        assertFields(
          history,
          requiredHistoryFields,
          `${archive.season} player ${index} history ${historyIndex}`,
        );
      }
      for (const [pastIndex, past] of (Array.isArray(player["history_past"])
        ? player["history_past"]
        : []
      ).entries()) {
        assertFields(
          past,
          requiredAggregateFields,
          `${archive.season} player ${index} history_past ${pastIndex}`,
        );
      }
    }
    if (!Array.isArray(archive.teams_data)) {
      throw new Error(`${archive.season} teams archive is invalid.`);
    }
    for (const team of archive.teams_data) {
      const history =
        team && typeof team === "object" && !Array.isArray(team)
          ? (team as Record<string, unknown>)["team_history"]
          : null;
      for (const row of Array.isArray(history) ? history : []) {
        assertFields(
          row,
          ["teamNPXG", "teamNPXGA"],
          `${archive.season} team history`,
        );
      }
    }
  }

  console.info(
    `[checkNonPenalty] ${season}: ${histories.length} histories, ${records.length} penalty rows, ${fixtures.length}/${sync.completed_fixture_count} fixtures verified.`,
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await checkNonPenaltyIntegrity();
  } catch (error) {
    console.error("Non-penalty integrity check failed:", error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
