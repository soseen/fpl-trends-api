import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import type {
  penalty_fixture_players,
  penalty_fixtures,
  penalty_records,
} from "@prisma/client";
import { enrichArchive } from "./enrichArchive.js";
import { enrichHistoryPast } from "./historyPast.js";
import {
  assertFootballerAnalyticsShape,
  assertTeamAnalyticsShape,
} from "./apiShape.js";
import {
  normalizeSeasonLabel,
  parseOptaCode,
  parsePremierLeagueFixture,
} from "../penalties/premierLeagueFeed.js";
import {
  validateFixtureCoverage,
  validateListedScoredPenalties,
} from "../penalties/syncPenaltyFeed.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./__fixtures__/official-penalty-sample.json", import.meta.url),
    "utf8",
  ),
) as {
  season: string;
  fixtures: Array<
    Omit<penalty_fixtures, "updated_at"> & { updated_at: string }
  >;
  penalties: Array<
    Omit<penalty_records, "updated_at"> & { updated_at: string }
  >;
  fixturePlayers: Array<
    Omit<penalty_fixture_players, "updated_at"> & { updated_at: string }
  >;
  footballers: unknown;
  teams: unknown;
};
const officialPayloads = JSON.parse(
  fs.readFileSync(
    new URL("./__fixtures__/official-feed-payloads.json", import.meta.url),
    "utf8",
  ),
) as { listedFixture: unknown; detailedFixture: unknown };

const input = () => ({
  season: fixture.season,
  footballers: structuredClone(fixture.footballers),
  teams: structuredClone(fixture.teams),
  fixtures: fixture.fixtures.map((row) => ({
    ...row,
    updated_at: new Date(row.updated_at),
  })),
  penaltyRecords: fixture.penalties.map((row) => ({
    ...row,
    updated_at: new Date(row.updated_at),
  })),
  fixturePlayers: fixture.fixturePlayers.map((row) => ({
    ...row,
    updated_at: new Date(row.updated_at),
  })),
  penaltyTotals: new Map(),
  deepCoveredSeasons: new Set([fixture.season]),
});

void describe("official feed joins and archive enrichment", () => {
  void it("normalizes season labels and exact Opta IDs", () => {
    assert.equal(normalizeSeasonLabel("2025/26"), "2025-26");
    assert.equal(
      normalizeSeasonLabel("English Premier League Season 2025/2026"),
      "2025-26",
    );
    assert.equal(normalizeSeasonLabel("2025/27"), null);
    assert.equal(parseOptaCode("g2645203", "g"), 2645203);
    assert.equal(parseOptaCode("p141746", "p"), 141746);
  });

  void it("validates saved official list and detail payload shapes", () => {
    const listed = parsePremierLeagueFixture(
      officialPayloads.listedFixture,
      "goals",
      new Set(["P"]),
    );
    assert.equal(listed.fixtureCode, 2562265);
    assert.deepEqual(listed.goals, [
      { type: "P", personId: 50727, teamId: null },
    ]);

    const detailed = parsePremierLeagueFixture(
      officialPayloads.detailedFixture,
      "events",
      new Set(["P", "MP", "SP"]),
    );
    assert.deepEqual(
      detailed.goals.map((event) => event.type),
      ["P", "MP", "MP"],
    );
    assert.deepEqual(detailed.playerTeams, [
      { playerCode: 231416, teamId: 131 },
      { playerCode: 15157, teamId: 131 },
      { playerCode: 50175, teamId: 12 },
    ]);
    assert.doesNotThrow(() =>
      validateListedScoredPenalties(
        listed.goals,
        detailed.goals,
        listed.fixtureCode,
      ),
    );
    assert.throws(() =>
      validateListedScoredPenalties(
        [{ type: "P", personId: 999, teamId: null }],
        detailed.goals,
        listed.fixtureCode,
      ),
    );
  });

  void it("requires exact completed-fixture coverage", () => {
    assert.equal(
      validateFixtureCoverage(
        [
          {
            id: 1,
            fixtureCode: 100,
            gameweek: 1,
            homeTeamId: 10,
            awayTeamId: 20,
            goals: [],
            playerTeams: [],
          },
        ],
        [{ id: 5, code: 100, event: 1, finished: true, team_h: 1, team_a: 2 }],
      ),
      1,
    );
    assert.throws(() =>
      validateFixtureCoverage(
        [],
        [{ id: 5, code: 100, event: 1, finished: true, team_h: 1, team_a: 2 }],
      ),
    );
  });

  void it("distinguishes zero-filled legacy rows from recorded expected data", () => {
    const legacy = enrichHistoryPast(
      {
        season_name: "2021/22",
        goals_scored: 2,
        minutes: 900,
        expected_goals: "0.00",
        expected_goal_involvements: "0.00",
      },
      123,
      new Map(),
      new Set(),
    );
    assert.equal(legacy.non_penalty_expected_goals, 0);
    assert.equal(legacy.non_penalty_expected_goal_involvements, 0);
    assert.throws(() =>
      enrichHistoryPast(
        {
          season_name: "2022/23",
          expected_goals: "0.10",
          expected_goal_involvements: "0.20",
        },
        123,
        new Map(),
        new Set(),
      ),
    );
  });

  void it("handles transfers, double gameweeks, team npxG/npxGA, and idempotency", () => {
    const first = enrichArchive(input());
    assert.doesNotThrow(() =>
      assertFootballerAnalyticsShape(first.footballers, "archived payload"),
    );
    assert.doesNotThrow(() =>
      assertTeamAnalyticsShape(first.teams, "archived payload"),
    );
    const transferred = first.footballers[0]!;
    const transferredHistory = transferred["history"] as Array<
      Record<string, unknown>
    >;
    assert.equal(transferredHistory[0]?.["fixture_code"], 100);
    assert.equal(transferredHistory[0]?.["non_penalty_expected_goals"], 0);
    assert.equal(transferredHistory[1]?.["fixture_code"], 102);
    assert.equal(transferredHistory[1]?.["non_penalty_expected_goals"], 0.2);

    const doubleGameweek = first.footballers[1]!["history"] as Array<
      Record<string, unknown>
    >;
    assert.deepEqual(
      doubleGameweek.map((row) => row["fixture_code"]),
      [101, 102],
    );

    const teamA = first.teams[0]!["team_history"] as Array<
      Record<string, unknown>
    >;
    const teamC = first.teams[2]!["team_history"] as Array<
      Record<string, unknown>
    >;
    assert.equal(teamA[0]?.["teamNPXG"], 0);
    assert.equal(teamA[1]?.["teamNPXG"], 0.5);
    assert.equal(teamC[0]?.["teamNPXG"], 0.2);
    assert.equal(teamC[0]?.["teamNPXGA"], 0.3);

    const second = enrichArchive({
      ...input(),
      footballers: first.footballers,
      teams: first.teams,
    });
    assert.deepEqual(second, first);
  });
});
