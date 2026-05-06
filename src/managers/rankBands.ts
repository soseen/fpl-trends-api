export type RankBand = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export const RANK_BAND_MAXES: ReadonlyArray<{
  band: RankBand;
  maxRank: number;
}> = [
  { band: 1, maxRank: 10_000 },
  { band: 2, maxRank: 50_000 },
  { band: 3, maxRank: 100_000 },
  { band: 4, maxRank: 250_000 },
  { band: 5, maxRank: 500_000 },
  { band: 6, maxRank: 1_000_000 },
  { band: 7, maxRank: 2_000_000 },
  { band: 8, maxRank: 4_000_000 },
  { band: 9, maxRank: Number.MAX_SAFE_INTEGER },
];

export const pickRankBand = (
  overallRank: number | null | undefined,
): RankBand | null => {
  if (overallRank === null || overallRank === undefined || overallRank <= 0) {
    return null;
  }

  return (
    RANK_BAND_MAXES.find(({ maxRank }) => overallRank <= maxRank)?.band ?? 9
  );
};

// SQL equivalent of pickRankBand(). The expression assumes the
// manager_summary table is aliased as `ms`.
export const RANK_BAND_SQL_CASE = `
  CASE
    WHEN ms.overall_rank IS NULL THEN NULL
    WHEN ms.overall_rank <= 10000 THEN 1
    WHEN ms.overall_rank <= 50000 THEN 2
    WHEN ms.overall_rank <= 100000 THEN 3
    WHEN ms.overall_rank <= 250000 THEN 4
    WHEN ms.overall_rank <= 500000 THEN 5
    WHEN ms.overall_rank <= 1000000 THEN 6
    WHEN ms.overall_rank <= 2000000 THEN 7
    WHEN ms.overall_rank <= 4000000 THEN 8
    ELSE 9
  END
`;
