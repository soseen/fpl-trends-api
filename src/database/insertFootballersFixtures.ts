import fs from "fs";
import { RAW_FOOTBALLERS_FILE } from "../file.helpers";
import { Footballer } from "../footballers/types";
import { prisma } from "./client";

export const insertFootballersFixtures = async () => {
  try {
    const rawData: Record<string, Footballer> = fs.existsSync(RAW_FOOTBALLERS_FILE)
      ? JSON.parse(fs.readFileSync(RAW_FOOTBALLERS_FILE, "utf8"))
      : {};

    const uniqueFixtures = new Map<number, any>();

    for (const footballer of Object.values(rawData)) {
      for (const fixture of footballer.fixtures) {
        if (!uniqueFixtures.has(fixture.id)) {
          uniqueFixtures.set(fixture.id, fixture);
        }
      }
    }

    const fixturesToInsert = Array.from(uniqueFixtures.values());

    // Insert or update fixtures
    await Promise.all(
      fixturesToInsert.map(async (fixture) => {
        await prisma.fixtures.upsert({
          where: { id: fixture.id },
          update: {
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
            id: fixture.id,
            code: fixture.code,
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
      })
    );

    const footballerFixtureRelations = [];

    for (const [footballerId, footballer] of Object.entries(rawData)) {
      for (const fixture of footballer.fixtures) {
        footballerFixtureRelations.push({
          footballer_id: parseInt(footballerId),
          fixture_id: fixture.id,
          is_home: fixture.is_home, 
          difficulty: fixture.difficulty, 
        });
      }
    }

    // Insert footballer-fixture relationships
    await prisma.footballer_fixtures.createMany({
      data: footballerFixtureRelations,
      skipDuplicates: true,
    });

    console.log("Fixtures data populated successfully.");
  } catch (error) {
    console.error(
      "Couldn't populate the fixtures table. Error:",
      (error as Error)?.message
    );
  } finally {
    await prisma.$disconnect();
  }
};
