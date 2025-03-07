import fs from "fs";
import {
  RAW_FOOTBALLERS_FILE,
  RAW_BOOTSTRAP_STATIC_FILE,
} from "../file.helpers.js";
import { Footballer } from "../footballers/types.js";
import { BootstrapStaticData } from "../bootstrapStatic/types.js";
import { prisma } from "./client.js";

export const insertTeamHistory = async () => {
  try {
    // Load footballers JSON
    const footballersData: Record<string, Footballer> = fs.existsSync(
      RAW_FOOTBALLERS_FILE,
    )
      ? JSON.parse(fs.readFileSync(RAW_FOOTBALLERS_FILE, "utf8"))
      : {};

    // Load teams JSON from bootstrap static
    const bootstrapData: BootstrapStaticData = fs.existsSync(
      RAW_BOOTSTRAP_STATIC_FILE,
    )
      ? JSON.parse(fs.readFileSync(RAW_BOOTSTRAP_STATIC_FILE, "utf8"))
      : { teams: [], elements: [] };

    // Map footballer_id -> team_id from bootstrap data
    const footballerToTeamMap = new Map<number, number>();
    for (const footballer of bootstrapData.elements) {
      footballerToTeamMap.set(footballer.id, footballer.team);
    }

    // Store team history data
    const teamHistoryMap = new Map<
      number,
      Map<
        number,
        {
          teamXGC: number;
          teamXGS: number;
          goals: number;
          goals_conceded: number;
        }
      >
    >();

    for (const [footballerIdStr, footballer] of Object.entries(
      footballersData,
    )) {
      const footballerId = parseInt(footballerIdStr, 10);
      const teamId = footballerToTeamMap.get(footballerId);
      if (!teamId) continue;

      for (const history of footballer.history ?? []) {
        const {
          round,
          expected_goals_conceded,
          expected_goals,
          goals_scored,
          goals_conceded,
        } = history;

        if (!teamHistoryMap.has(teamId)) {
          teamHistoryMap.set(teamId, new Map());
        }
        const teamData = teamHistoryMap.get(teamId)!;

        if (!teamData.has(round)) {
          teamData.set(round, {
            teamXGC: 0,
            teamXGS: 0,
            goals: 0,
            goals_conceded: 0,
          });
        }

        const currentHistory = teamData.get(round)!;

        // Max expected goals conceded (XGC)
        currentHistory.teamXGC = Math.max(
          currentHistory.teamXGC,
          parseFloat(expected_goals_conceded) || 0,
        );

        // Sum expected goals scored (XGS)
        currentHistory.teamXGS += parseFloat(expected_goals) || 0;

        // Sum total goals scored
        currentHistory.goals += goals_scored || 0;

        // Max total goals conceded
        currentHistory.goals_conceded = Math.max(
          currentHistory.goals_conceded,
          goals_conceded || 0,
        );
      }
    }

    // Insert/Update team history from map
    for (const [teamId, rounds] of teamHistoryMap.entries()) {
      for (const [round, history] of rounds.entries()) {
        await prisma.team_history.upsert({
          where: { team_id_round: { team_id: teamId, round } }, // Ensure uniqueness
          update: history, // Update existing data
          create: { team_id: teamId, round, ...history }, // Insert new data
        });
      }
    }

    console.log("Team history data populated successfully.");
  } catch (error) {
    console.error(
      "Couldn't populate team history table. Error:",
      (error as Error)?.message,
    );
  } finally {
    await prisma.$disconnect();
  }
};

insertTeamHistory();
