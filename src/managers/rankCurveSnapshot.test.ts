import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LeagueStandingsResponse } from "./types.js";
import {
  buildStandingsPagePlan,
  collectOverallRankCurveSnapshot,
  validateOverallRankCurveSnapshot,
} from "./rankCurveSnapshot.js";

void describe("overall rank curve snapshots", () => {
  void it("samples the standings densely near the top and through the tail", () => {
    const pages = buildStandingsPagePlan(2_500_000);
    assert.equal(pages[0], 1);
    assert.equal(pages.at(-1), 50_000);
    assert.equal(new Set(pages).size, pages.length);
    assert.ok(pages.includes(5)); // rank 201-250
    assert.ok(pages.includes(200)); // rank 9,951-10,000
    assert.ok(pages.includes(40_000)); // rank near 2m
  });

  void it("collects coherent score/rank milestones and tolerates a few failed pages", async () => {
    const maximumRank = 120_000;
    const pages = buildStandingsPagePlan(maximumRank);
    const failedPage = pages[Math.floor(pages.length / 2)];
    const fetchPage = (page: number): Promise<LeagueStandingsResponse> => {
      if (page === failedPage) {
        return Promise.reject(new Error("temporary upstream failure"));
      }
      const firstRank = (page - 1) * 50 + 1;
      return Promise.resolve({
        standings: {
          has_next: firstRank + 49 < maximumRank,
          page,
          results: Array.from({ length: 50 }, (_, index) => {
            const rank = firstRank + index;
            return {
              entry: rank,
              rank,
              total: 300 - Math.floor(rank / 1_000),
              player_name: "Sample",
              entry_name: "Sample XI",
            };
          }),
        },
      });
    };

    const snapshot = await collectOverallRankCurveSnapshot(
      maximumRank,
      fetchPage,
      0,
    );
    assert.equal(snapshot.pagesRequested, pages.length);
    assert.equal(snapshot.pagesFetched, pages.length - 1);
    assert.equal(snapshot.minRank, 1);
    assert.ok(snapshot.maxRank >= maximumRank * 0.9);
    assert.deepEqual(
      validateOverallRankCurveSnapshot(snapshot, maximumRank),
      [],
    );
  });

  void it("stores the sampled midpoint of a tied score band", async () => {
    const snapshot = await collectOverallRankCurveSnapshot(
      1_000,
      (page) => {
        const firstRank = (page - 1) * 50 + 1;
        return Promise.resolve({
          standings: {
            has_next: firstRank + 49 < 1_000,
            page,
            results: Array.from({ length: 50 }, (_, index) => ({
              entry: firstRank + index,
              rank: firstRank + index,
              total: 42,
              player_name: "Tied",
              entry_name: "Tied XI",
            })),
          },
        });
      },
      0,
    );

    assert.equal(snapshot.milestones.length, 1);
    assert.ok((snapshot.milestones[0]?.rank ?? 0) > 400);
    assert.ok((snapshot.milestones[0]?.rank ?? 0) < 600);
  });

  void it("rejects snapshots without head or tail coverage", () => {
    const errors = validateOverallRankCurveSnapshot(
      {
        milestones: Array.from({ length: 5 }, (_, index) => ({
          score: index,
          rank: 10_000 + index,
        })),
        pagesRequested: 10,
        pagesFetched: 10,
        managersSampled: 500,
        minRank: 10_000,
        maxRank: 20_000,
      },
      100_000,
    );
    assert.ok(errors.some((error) => error.includes("top-rank coverage")));
    assert.ok(errors.some((error) => error.includes("tail coverage")));
  });
});
