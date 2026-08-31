import { prisma } from "../database/client.js";
import { delay } from "../utils.js";
import { fetchLeagueStandingsPage, OVERALL_LEAGUE_ID } from "./fetchManager.js";
import type { LeagueStandingsResponse } from "./types.js";

const RESULTS_PER_PAGE = 50;
const FETCH_BATCH_SIZE = 8;
const INTER_BATCH_DELAY_MS = 200;
const MIN_FETCH_SUCCESS_RATE = 0.8;
const MIN_DISTINCT_SCORES = 5;
const MIN_HEAD_COVERAGE_RANK = 1_000;
const MAX_RANK_CAP = 15_000_000;

export type RankCurveMilestone = {
  score: number;
  rank: number;
};

export type RankCurveSnapshotData = {
  milestones: RankCurveMilestone[];
  pagesRequested: number;
  pagesFetched: number;
  managersSampled: number;
  minRank: number;
  maxRank: number;
};

type StandingsPageFetcher = (page: number) => Promise<LeagueStandingsResponse>;

const pageForRank = (rank: number): number =>
  Math.floor((Math.max(1, rank) - 1) / RESULTS_PER_PAGE) + 1;

const addRankTargets = (
  pages: Set<number>,
  startRank: number,
  endRank: number,
  step: number,
): void => {
  if (startRank > endRank) return;
  for (let rank = startRank; rank <= endRank; rank += step) {
    pages.add(pageForRank(rank));
  }
};

// The score distribution is steep near the top and progressively flatter in
// the tail, so sample ranks densely near rank 1 and more coarsely lower down.
// This is independent of the slower manager-history sample: about 400-500
// lightweight standings pages produce one coherent live curve every cron run.
export const buildStandingsPagePlan = (maximumRank: number): number[] => {
  const cap = Math.min(MAX_RANK_CAP, Math.max(1, Math.trunc(maximumRank)));
  const pages = new Set<number>([1]);

  addRankTargets(pages, 250, Math.min(cap, 10_000), 250);
  addRankTargets(pages, 11_000, Math.min(cap, 100_000), 1_000);
  addRankTargets(pages, 105_000, Math.min(cap, 500_000), 5_000);
  addRankTargets(pages, 510_000, Math.min(cap, 2_000_000), 10_000);
  addRankTargets(pages, 2_050_000, cap, 50_000);
  pages.add(pageForRank(cap));

  return Array.from(pages).sort((a, b) => a - b);
};

export const collectOverallRankCurveSnapshot = async (
  maximumRank: number,
  fetchPage: StandingsPageFetcher = (page) =>
    fetchLeagueStandingsPage(OVERALL_LEAGUE_ID, page),
  interBatchDelayMs = INTER_BATCH_DELAY_MS,
): Promise<RankCurveSnapshotData> => {
  const pages = buildStandingsPagePlan(maximumRank);
  const ranksByScore = new Map<number, { sum: number; count: number }>();
  let pagesFetched = 0;
  let managersSampled = 0;
  let minRank = Number.POSITIVE_INFINITY;
  let maxRank = 0;

  for (let index = 0; index < pages.length; index += FETCH_BATCH_SIZE) {
    const batch = pages.slice(index, index + FETCH_BATCH_SIZE);
    const responses = await Promise.all(
      batch.map(async (page) => {
        try {
          return await fetchPage(page);
        } catch {
          return null;
        }
      }),
    );

    for (const response of responses) {
      if (response === null) continue;
      pagesFetched += 1;
      const rows = response.standings.results ?? [];
      managersSampled += rows.length;
      for (const row of rows) {
        const score = Math.trunc(row.total);
        const rank = Math.trunc(row.rank);
        if (!Number.isFinite(score) || !Number.isFinite(rank) || rank <= 0) {
          continue;
        }
        const existing = ranksByScore.get(score) ?? { sum: 0, count: 0 };
        existing.sum += rank;
        existing.count += 1;
        ranksByScore.set(score, existing);
        minRank = Math.min(minRank, rank);
        maxRank = Math.max(maxRank, rank);
      }
    }

    if (index + FETCH_BATCH_SIZE < pages.length && interBatchDelayMs > 0) {
      await delay(interBatchDelayMs);
    }
  }

  return {
    // Use the sampled midpoint of each tied-score band. Taking only its best
    // rank would put every manager at the front of the tie and systematically
    // distort one-point movement at common scores.
    milestones: Array.from(ranksByScore, ([score, ranks]) => ({
      score,
      rank: Math.round(ranks.sum / ranks.count),
    })).sort((a, b) => a.score - b.score),
    pagesRequested: pages.length,
    pagesFetched,
    managersSampled,
    minRank: Number.isFinite(minRank) ? minRank : 0,
    maxRank,
  };
};

export const validateOverallRankCurveSnapshot = (
  snapshot: RankCurveSnapshotData,
  requiredTailRank: number,
): string[] => {
  const errors: string[] = [];
  if (
    snapshot.pagesFetched <
    Math.ceil(snapshot.pagesRequested * MIN_FETCH_SUCCESS_RATE)
  ) {
    errors.push(
      `only ${snapshot.pagesFetched}/${snapshot.pagesRequested} standings pages loaded`,
    );
  }
  if (snapshot.milestones.length < MIN_DISTINCT_SCORES) {
    errors.push(
      `only ${snapshot.milestones.length} distinct score milestones loaded`,
    );
  }
  if (snapshot.minRank <= 0 || snapshot.minRank > MIN_HEAD_COVERAGE_RANK) {
    errors.push(`top-rank coverage starts at ${snapshot.minRank || "none"}`);
  }
  if (
    requiredTailRank > 0 &&
    snapshot.maxRank < Math.floor(requiredTailRank * 0.9)
  ) {
    errors.push(
      `tail coverage ends at ${snapshot.maxRank}, below required ${requiredTailRank}`,
    );
  }
  return errors;
};

export type PublishedRankCurveSnapshot = RankCurveSnapshotData & {
  gw: number;
  capturedAt: Date;
  isFinal: boolean;
};

export const refreshOverallRankCurveSnapshot = async ({
  gw,
  isFinal,
  rankedCount,
}: {
  gw: number;
  isFinal: boolean;
  rankedCount: number;
}): Promise<PublishedRankCurveSnapshot> => {
  const maximumRank = Math.min(
    MAX_RANK_CAP,
    Math.max(100_000, Math.ceil(rankedCount * 1.2)),
  );
  const snapshot = await collectOverallRankCurveSnapshot(maximumRank);
  const errors = validateOverallRankCurveSnapshot(snapshot, rankedCount);
  if (errors.length > 0) {
    throw new Error(`rank curve snapshot rejected: ${errors.join("; ")}`);
  }

  const capturedAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.overall_rank_curve_snapshots.upsert({
      where: { gw },
      update: {
        captured_at: capturedAt,
        is_final: isFinal,
        pages_requested: snapshot.pagesRequested,
        pages_sampled: snapshot.pagesFetched,
        managers_sampled: snapshot.managersSampled,
        min_rank: snapshot.minRank,
        max_rank: snapshot.maxRank,
      },
      create: {
        gw,
        captured_at: capturedAt,
        is_final: isFinal,
        pages_requested: snapshot.pagesRequested,
        pages_sampled: snapshot.pagesFetched,
        managers_sampled: snapshot.managersSampled,
        min_rank: snapshot.minRank,
        max_rank: snapshot.maxRank,
      },
    });
    await tx.overall_rank_curve_points.deleteMany({ where: { gw } });
    await tx.overall_rank_curve_points.createMany({
      data: snapshot.milestones.map((milestone) => ({
        gw,
        score: milestone.score,
        rank: milestone.rank,
      })),
    });
  });

  return { ...snapshot, gw, capturedAt, isFinal };
};
