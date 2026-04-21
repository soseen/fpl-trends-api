import fs from "fs";
import { RAW_FOOTBALLERS_FILE } from "../file.helpers.js";
import type { Fixture, Footballer } from "../footballers/types.js";
import { prisma } from "./client.js";

export const insertFootballersFixtures = async () => {
  try {
    const rawData: Record<string, Footballer> = fs.existsSync(
      RAW_FOOTBALLERS_FILE,
    )
      ? JSON.parse(fs.readFileSync(RAW_FOOTBALLERS_FILE, "utf8"))
      : {};

    const uniqueFixtures = new Map<number, Fixture>();

    for (const footballer of Object.values(rawData)) {
      for (const fixture of footballer.fixtures) {
        if (!uniqueFixtures.has(fixture.id)) {
          uniqueFixtures.set(fixture.id, fixture);
        }
      }
    }

    const existingFixtures = await prisma.footballer_fixtures.findMany({
      select: { id: true },
    });

    const existingFixtureIds = new Set(existingFixtures.map((f) => f.id));

    const fixtureIdsToDelete = [...existingFixtureIds].filter(
      (id) => !uniqueFixtures.has(id),
    );

    if (fixtureIdsToDelete.length > 0) {
      console.info(`Deleting ${fixtureIdsToDelete.length} old fixtures...`);

      await prisma.footballer_fixtures.deleteMany({
        where: { fixture_id: { in: fixtureIdsToDelete } },
      });

      await prisma.footballer_fixtures.deleteMany({
        where: { id: { in: fixtureIdsToDelete } },
      });
    }

    await Promise.all(
      Object.entries(rawData).flatMap(([footballerId, footballer]) =>
        footballer.fixtures.map(async (fixture) => {
          await prisma.footballer_fixtures.upsert({
            where: {
              footballer_id_fixture_id: {
                footballer_id: parseInt(footballerId),
                fixture_id: fixture.id,
              },
            },
            update: {
              is_home: fixture.is_home,
              difficulty: fixture.difficulty,
              team_h: fixture.team_h,
              team_h_score: fixture.team_h_score,
              team_a: fixture.team_a,
              team_a_score: fixture.team_a_score,
              event: fixture.event,
              finished: fixture.finished,
              minutes: fixture.minutes,
              provisional_start_time: fixture.provisional_start_time,
              kickoff_time: new Date(fixture.kickoff_time),
              event_name: fixture.event_name,
            },
            create: {
              footballer_id: parseInt(footballerId),
              fixture_id: fixture.id,
              is_home: fixture.is_home,
              difficulty: fixture.difficulty,
              team_h: fixture.team_h,
              team_h_score: fixture.team_h_score,
              team_a: fixture.team_a,
              team_a_score: fixture.team_a_score,
              event: fixture.event,
              finished: fixture.finished,
              minutes: fixture.minutes,
              provisional_start_time: fixture.provisional_start_time,
              kickoff_time: new Date(fixture.kickoff_time),
              event_name: fixture.event_name,
            },
          });
        }),
      ),
    );

    console.info("Fixtures data populated successfully.");
  } catch (error) {
    console.error(
      "Couldn't populate the fixtures table. Error:",
      (error as Error)?.message,
    );
  } finally {
    await prisma.$disconnect();
  }
};
