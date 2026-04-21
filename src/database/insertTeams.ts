import fs from "fs";
import { RAW_BOOTSTRAP_STATIC_FILE } from "../file.helpers.js";
import type { BootstrapStaticData } from "../bootstrapStatic/types.js";
import { prisma } from "./client.js";

export const insertTeams = async () => {
  try {
    const rawData: BootstrapStaticData = JSON.parse(
      fs.readFileSync(RAW_BOOTSTRAP_STATIC_FILE, "utf8"),
    );

    for (const team of rawData.teams) {
      await prisma.teams.upsert({
        where: { code: team.code },
        update: {
          name: team.name,
          short_name: team.short_name,
          strength: team.strength,
          strength_overall_home: team.strength_overall_home,
          strength_overall_away: team.strength_overall_away,
          strength_attack_home: team.strength_attack_home,
          strength_attack_away: team.strength_attack_away,
          strength_defence_home: team.strength_defence_home,
          strength_defence_away: team.strength_defence_away,
          pulse_id: team.pulse_id,
          unavailable: team.unavailable,
        },
        create: {
          id: team.id,
          code: team.code,
          name: team.name,
          short_name: team.short_name,
          strength: team.strength,
          strength_overall_home: team.strength_overall_home,
          strength_overall_away: team.strength_overall_away,
          strength_attack_home: team.strength_attack_home,
          strength_attack_away: team.strength_attack_away,
          strength_defence_home: team.strength_defence_home,
          strength_defence_away: team.strength_defence_away,
          pulse_id: team.pulse_id,
          unavailable: team.unavailable,
        },
      });
    }
    console.info("Teams populated successfully.");
  } catch (error) {
    console.error(
      "Couldn't populate the teams table. Error:",
      (error as Error).message,
    );
  } finally {
    await prisma.$disconnect();
  }
};
