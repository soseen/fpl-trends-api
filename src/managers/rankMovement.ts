export type ScoreRankMilestone = {
  score: number;
  rank: number;
};

export type RankMovementEstimator = {
  rankAtScore: (score: number) => number;
  impactForExcess: (userOverallTotal: number, excessPoints: number) => number;
};

// Builds the same kind of score-to-rank milestone curve used by live rank
// sites. Because each sampled manager carries an official rank, interpolation
// is calibrated to the actual standings rather than relying on a potentially
// biased sample-density extrapolation.
export const createRankMovementEstimator = (
  milestones: ReadonlyArray<ScoreRankMilestone>,
): RankMovementEstimator | null => {
  const ranksByScore = new Map<number, { sum: number; count: number }>();
  for (const milestone of milestones) {
    if (!Number.isFinite(milestone.score) || !Number.isFinite(milestone.rank)) {
      continue;
    }
    if (milestone.rank <= 0) continue;
    const score = Math.trunc(milestone.score);
    const existing = ranksByScore.get(score) ?? { sum: 0, count: 0 };
    existing.sum += milestone.rank;
    existing.count += 1;
    ranksByScore.set(score, existing);
  }

  if (ranksByScore.size < 2) return null;

  const curve = Array.from(ranksByScore, ([score, value]) => ({
    score,
    rank: value.sum / value.count,
  })).sort((a, b) => a.score - b.score);

  // Sampling noise must never imply that a higher score has a worse rank.
  for (let index = 1; index < curve.length; index += 1) {
    const previous = curve[index - 1];
    const current = curve[index];
    if (!previous || !current) continue;
    current.rank = Math.min(current.rank, previous.rank);
  }

  const maximumRank = Math.max(...curve.map(({ rank }) => rank));

  const rankAtScore = (score: number): number => {
    if (!Number.isFinite(score)) return Number.NaN;
    let lower = curve[0];
    let upper = curve[1];

    if (score >= (curve[curve.length - 1]?.score ?? score)) {
      lower = curve[curve.length - 2];
      upper = curve[curve.length - 1];
    } else if (score > (curve[0]?.score ?? score)) {
      for (let index = 1; index < curve.length; index += 1) {
        const candidate = curve[index];
        if (candidate && score <= candidate.score) {
          lower = curve[index - 1];
          upper = candidate;
          break;
        }
      }
    }

    if (!lower || !upper || upper.score === lower.score) return Number.NaN;
    const fraction = (score - lower.score) / (upper.score - lower.score);
    const interpolated = lower.rank + fraction * (upper.rank - lower.rank);
    return Math.max(1, Math.min(maximumRank, interpolated));
  };

  return {
    rankAtScore,
    impactForExcess: (userOverallTotal, excessPoints) =>
      rankAtScore(userOverallTotal - excessPoints) -
      rankAtScore(userOverallTotal),
  };
};
