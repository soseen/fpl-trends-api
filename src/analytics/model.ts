import { z } from "zod";

export const CALCULATION_VERSION = 2;
export const strata = [1, 2, 3] as const;
export type Stratum = (typeof strata)[number];
const number = z.number().finite();
const nullable = number.nullable();
const count = z.number().int().nonnegative();

export const cohortSchema = z.object({
  avg_total_points: nullable,
  avg_transfers: nullable,
  avg_hits: nullable,
  avg_bench: nullable,
  avg_captain_bonus: nullable,
  avg_gw_score: nullable,
  wildcards_h1_rate: nullable,
  wildcards_h2_rate: nullable,
  free_hits_h1_rate: nullable,
  free_hits_h2_rate: nullable,
  bench_boosts_h1_rate: nullable,
  bench_boosts_h2_rate: nullable,
  triple_captains_h1_rate: nullable,
  triple_captains_h2_rate: nullable,
  sample_size: count,
  with_hits_data: count,
  with_bench_data: count,
  with_transfers_data: count,
  with_captain_data: count,
  with_chips_data: count,
});
export const cohortsSchema = z.object({
  average: cohortSchema,
  top100k: cohortSchema,
  top10k: cohortSchema,
});
const meansSchema = z.object({
  average: nullable,
  top100k: nullable,
  top10k: nullable,
});
export const exposureSchema = z.object({
  band: z.number().int().min(0).max(9),
  element: z.number().int().positive(),
  ownership: number.min(0).max(1),
  eo: number.min(0).max(3),
  captainRate: number.min(0).max(1),
  tripleCaptainRate: number.min(0).max(1),
  intendedCaptainRate: number.min(0).max(1),
  effectiveSampleSize: number.positive(),
});
export const benchmarkSchema = z.object({
  version: z.literal(CALCULATION_VERSION),
  season: z.string().regex(/^\d{4}-\d{2}$/),
  gw: z.number().int().min(1).max(38),
  generatedAt: z.string().datetime(),
  sourceRevision: z.string(),
  population: z.number().int().positive(),
  finalized: z.boolean(),
  sampleCounts: z.tuple([count, count, count]),
  captainBonuses: meansSchema,
  captainChoices: z.object({
    average: z.array(z.object({ element: count, rate: number })),
    top100k: z.array(z.object({ element: count, rate: number })),
    top10k: z.array(z.object({ element: count, rate: number })),
  }),
  curve: z
    .object({
      points: z.array(z.object({ score: number, rank: number.positive() })),
      capturedAt: z.string().datetime(),
    })
    .nullable(),
  exposures: z.array(exposureSchema),
  ranges: z.array(
    z.object({
      startGw: z.number().int().min(1).max(38),
      cohorts: cohortsSchema,
      transferMeans: meansSchema,
      transferCoverage: z.object({
        average: z.object({
          with_data: count,
          with_transfers: count,
          stratum_size: count,
        }),
        top100k: z.object({
          with_data: count,
          with_transfers: count,
          stratum_size: count,
        }),
        top10k: z.object({
          with_data: count,
          with_transfers: count,
          stratum_size: count,
        }),
      }),
      buckets: z.array(
        z.object({
          stratum: z.union([z.literal(1), z.literal(2), z.literal(3)]),
          score: number,
          managers: count,
        }),
      ),
      stratumAverages: z.tuple([nullable, nullable, nullable]),
    }),
  ),
});
export type Benchmark = z.infer<typeof benchmarkSchema>;
export type Exposure = z.infer<typeof exposureSchema>;
export type Cohort = z.infer<typeof cohortSchema>;

export type ManagerFact = {
  gw: number;
  points: number;
  rank: number | null;
  transfers: number | null;
  hits: number | null;
  bench: number | null;
  chip: string | null;
  captain: number | null;
};
export type SquadPick = {
  element: number;
  position: number;
  multiplier: number;
  captain: boolean;
  vice: boolean;
};
export type SampleManager = {
  cluster?: number;
  entry: number;
  stratum: Stratum;
  facts: ManagerFact[];
  picks: SquadPick[];
  transfers: { gw: number; in: number; out: number }[];
  transfersComplete: boolean;
  chipsComplete: boolean;
};
export type PlayerPoints = ReadonlyMap<string, number>;
export const sampleManagerSchema: z.ZodType<SampleManager> = z.object({
  cluster: z.number().int().positive().optional(),
  entry: z.number().int().positive(),
  stratum: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  facts: z
    .array(
      z.object({
        gw: z.number().int().min(1).max(38),
        points: z.number().int(),
        rank: z.number().int().nullable(),
        transfers: z.number().int().nonnegative().nullable(),
        hits: z.number().int().nonnegative().nullable(),
        bench: z.number().int().nullable(),
        chip: z.string().nullable(),
        captain: z.number().int().positive().nullable(),
      }),
    )
    .refine(
      (f) => new Set(f.map((r) => r.gw)).size === f.length,
      "Duplicate history GWs",
    ),
  picks: z.array(
    z.object({
      element: z.number().int().positive(),
      position: z.number().int().min(1).max(15),
      multiplier: z.number().int().min(0).max(3),
      captain: z.boolean(),
      vice: z.boolean(),
    }),
  ),
  transfers: z.array(
    z.object({
      gw: z.number().int().min(1).max(38),
      in: z.number().int().positive(),
      out: z.number().int().positive(),
    }),
  ),
  transfersComplete: z.boolean(),
  chipsComplete: z.boolean(),
});
export const benchmarkSourceSchema = z.object({
  format: z.literal(1),
  checkSquadScores: z.literal(true),
  season: z.string(),
  gw: z.number().int().min(1).max(38),
  population: z.number().int().positive(),
  managers: z.array(sampleManagerSchema),
  followedTop10k: z
    .array(
      z.object({
        startGw: z.number().int().min(2).max(38),
        anchorRevision: z.string(),
        selectedEntries: z.array(z.number().int().positive()).length(300),
        managers: z.array(sampleManagerSchema),
      }),
    )
    .optional(),
  points: z.array(
    z.object({
      footballer_id: z.number().int().positive(),
      round: z.number().int().min(1).max(38),
      points: z.number().int(),
    }),
  ),
});
export const pointKey = (element: number, gw: number): string =>
  `${element}:${gw}`;
export const populationSizes = (
  population: number,
): Record<Stratum, number> => ({
  1: Math.min(population, 10_000),
  2: Math.max(0, Math.min(population, 100_000) - 10_000),
  3: Math.max(0, population - 100_000),
});

export const validSquad = (picks: readonly SquadPick[]): boolean =>
  picks.length === 15 &&
  new Set(picks.map((p) => p.element)).size === 15 &&
  new Set(picks.map((p) => p.position)).size === 15 &&
  picks.every(
    (p) =>
      Number.isInteger(p.element) &&
      p.element > 0 &&
      Number.isInteger(p.position) &&
      p.position >= 1 &&
      p.position <= 15 &&
      Number.isInteger(p.multiplier) &&
      p.multiplier >= 0 &&
      p.multiplier <= 3,
  ) &&
  picks.filter((p) => p.captain).length === 1 &&
  picks.filter((p) => p.vice).length === 1 &&
  picks.every(
    (p) => !(p.captain && p.vice) && (p.multiplier <= 1 || p.captain || p.vice),
  ) &&
  picks.filter((p) => p.multiplier > 1).length <= 1;

// One definition on BOTH sides of the comparison: raw IN-minus-OUT points
// from the transfer GW through range end. This descriptive benchmark excludes
// chip transfers and does not infer counterfactual lineups or captaincy.
export const rawTransferAverage = (
  manager: Pick<SampleManager, "transfers" | "facts" | "transfersComplete">,
  points: PlayerPoints,
  start: number,
  end: number,
): number | null => {
  if (!manager.transfersComplete) return null;
  const chips = new Set(
    manager.facts
      .filter((f) => f.chip === "wildcard" || f.chip === "freehit")
      .map((f) => f.gw),
  );
  const transfers = manager.transfers.filter(
    (t) => t.gw >= start && t.gw <= end && !chips.has(t.gw),
  );
  if (transfers.length === 0) return null;
  let total = 0;
  for (const transfer of transfers)
    for (let gw = transfer.gw; gw <= end; gw++) {
      total +=
        (points.get(pointKey(transfer.in, gw)) ?? 0) -
        (points.get(pointKey(transfer.out, gw)) ?? 0);
    }
  return total / transfers.length;
};
