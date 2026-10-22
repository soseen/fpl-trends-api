import fs from "node:fs";
import { z } from "zod";
import { RAW_FOOTBALLERS_FILE } from "../file.helpers.js";
import { prisma } from "./client.js";

const fixtureSchema = z.object({
  id: z.number().int().positive(),
  is_home: z.boolean(),
  difficulty: z.number().int().min(1).max(5),
  team_h: z.number().int().positive(),
  team_h_score: z.number().int().nonnegative().nullable(),
  team_a: z.number().int().positive(),
  team_a_score: z.number().int().nonnegative().nullable(),
  event: z.number().int().min(1).max(38).nullable(),
  finished: z.boolean(),
  minutes: z.number().int().nonnegative(),
  provisional_start_time: z.boolean(),
  kickoff_time: z.string().datetime({ offset: true }).nullable(),
  event_name: z.string().nullable(),
});
const sourceSchema = z
  .record(
    z.string().regex(/^[1-9]\d*$/),
    z.object({ fixtures: z.array(fixtureSchema) }),
  )
  .refine((source) => Object.keys(source).length > 0, "Empty player snapshot");

export const replaceFootballersFixtures = async (
  input: unknown,
): Promise<number> => {
  const source = sourceSchema.parse(input);
  const seen = new Set<string>();
  const rows = Object.entries(source).flatMap(([id, player]) => {
    const footballer_id = z
      .number()
      .int()
      .positive()
      .max(2_147_483_647)
      .parse(Number(id));
    return player.fixtures.map(({ id: fixture_id, ...fixture }) => {
      const key = `${footballer_id}:${fixture_id}`;
      if (seen.has(key)) throw new Error(`Duplicate player fixture ${key}`);
      seen.add(key);
      return {
        footballer_id,
        fixture_id,
        ...fixture,
        kickoff_time:
          fixture.kickoff_time === null
            ? null
            : new Date(fixture.kickoff_time).toISOString(),
      };
    });
  });
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout='30s'");
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout='2s'");
      // Compare natural player/fixture keys. A row's serial ID is unrelated to
      // FPL's fixture ID; mixing them used to delete valid rows and retain stale ones.
      await tx.$executeRaw`DELETE FROM footballer_fixtures existing WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(rows.map((r) => ({ footballer_id: r.footballer_id, fixture_id: r.fixture_id })))}::jsonb)
      AS wanted(footballer_id int,fixture_id int)
      WHERE wanted.footballer_id=existing.footballer_id AND wanted.fixture_id=existing.fixture_id)`;
      // One SQL statement per bounded batch, rather than 20k simultaneous
      // promises waiting for four Prisma connections. Keep replacement atomic.
      for (let offset = 0; offset < rows.length; offset += 500) {
        await tx.$executeRaw`INSERT INTO footballer_fixtures AS existing
        (footballer_id,fixture_id,is_home,difficulty,team_h,team_h_score,team_a,team_a_score,event,finished,minutes,provisional_start_time,kickoff_time,event_name)
        SELECT footballer_id,fixture_id,is_home,difficulty,team_h,team_h_score,team_a,team_a_score,event,finished,minutes,provisional_start_time,kickoff_time,event_name
        FROM jsonb_to_recordset(${JSON.stringify(rows.slice(offset, offset + 500))}::jsonb) AS f(
          footballer_id int,fixture_id int,is_home boolean,difficulty int,team_h int,team_h_score int,team_a int,team_a_score int,event int,finished boolean,minutes int,provisional_start_time boolean,kickoff_time timestamp,event_name text)
        ON CONFLICT(footballer_id,fixture_id) DO UPDATE SET
          is_home=excluded.is_home,difficulty=excluded.difficulty,team_h=excluded.team_h,team_h_score=excluded.team_h_score,
          team_a=excluded.team_a,team_a_score=excluded.team_a_score,event=excluded.event,finished=excluded.finished,
          minutes=excluded.minutes,provisional_start_time=excluded.provisional_start_time,kickoff_time=excluded.kickoff_time,event_name=excluded.event_name
        WHERE (existing.is_home,existing.difficulty,existing.team_h,existing.team_h_score,existing.team_a,existing.team_a_score,existing.event,existing.finished,existing.minutes,existing.provisional_start_time,existing.kickoff_time,existing.event_name)
          IS DISTINCT FROM (excluded.is_home,excluded.difficulty,excluded.team_h,excluded.team_h_score,excluded.team_a,excluded.team_a_score,excluded.event,excluded.finished,excluded.minutes,excluded.provisional_start_time,excluded.kickoff_time,excluded.event_name)`;
      }
    },
    { timeout: 60_000, maxWait: 5000 },
  );
  return rows.length;
};

export const insertFootballersFixtures = async (): Promise<void> => {
  const source: unknown = JSON.parse(
    fs.readFileSync(RAW_FOOTBALLERS_FILE, "utf8"),
  );
  const fixtures = await replaceFootballersFixtures(source);
  console.info(
    JSON.stringify({ event: "footballer_fixtures_published", fixtures }),
  );
};
