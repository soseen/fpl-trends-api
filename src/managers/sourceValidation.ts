import { z } from "zod";
const integer = z.number().int();
const positive = integer.positive(),
  count = integer.nonnegative();
export const summarySchema = z.object({
  id: positive,
  name: z.string(),
  player_first_name: z.string(),
  player_last_name: z.string(),
  summary_overall_points: integer.nullable(),
  summary_overall_rank: positive.nullable(),
  summary_event_points: integer.nullable(),
  summary_event_rank: positive.nullable(),
  current_event: positive.nullable(),
});
export const historySchema = z
  .object({
    current: z.array(
      z.object({
        event: positive.max(38),
        points: integer,
        total_points: integer,
        rank: integer.nullable().transform((v) => v ?? 0),
        rank_sort: integer.nullable().transform((v) => v ?? 0),
        overall_rank: integer.nullable().transform((v) => v ?? 0),
        percentile_rank: z
          .number()
          .nullable()
          .optional()
          .transform((v) => v ?? 0),
        bank: integer,
        value: integer,
        event_transfers: count,
        event_transfers_cost: count,
        points_on_bench: integer,
      }),
    ),
    past: z.array(
      z.object({
        season_name: z.string(),
        total_points: integer,
        rank: positive,
      }),
    ),
    chips: z.array(
      z.object({
        name: z.enum(["wildcard", "freehit", "bboost", "3xc", "manager"]),
        time: z.string(),
        event: positive.max(38),
      }),
    ),
  })
  .refine(
    (v) => new Set(v.current.map((f) => f.event)).size === v.current.length,
    "Duplicate manager history gameweeks",
  );
export const pickSchema = z.object({
  element: positive,
  position: positive.max(15),
  multiplier: count.max(3),
  is_captain: z.boolean(),
  is_vice_captain: z.boolean(),
});
export const picksSchema = z.object({
  active_chip: z
    .enum(["wildcard", "freehit", "bboost", "3xc", "manager"])
    .nullable(),
  picks: z.array(pickSchema),
  entry_history: z.object({
    points: integer,
    total_points: integer,
    rank: integer.nullable(),
    overall_rank: integer.nullable(),
  }),
});
export const transfersSchema = z.array(
  z.object({
    element_in: positive,
    element_in_cost: count,
    element_out: positive,
    element_out_cost: count,
    entry: positive,
    event: positive.max(38),
    time: z.string().optional(),
  }),
);
