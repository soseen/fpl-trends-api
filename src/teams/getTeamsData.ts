import { prisma } from "../database/client.js";

export const getTeamsData = async () => {
  const teams = await prisma.teams.findMany({
    include: { footballers: { include: { history: true } } },
  });

  return teams.map((team) => {
    const history: {
      round: number;
      teamXGC: number;
      teamXGS: number;
      goals: number;
      goals_conceded: number;
    }[] = [];

    const allGameweeks = new Set<number>();
    team.footballers.forEach((footballer) => {
      footballer.history.forEach((history) => allGameweeks.add(history.round));
    });

    allGameweeks.forEach((gw) => {
      const teamXGC = Math.max(
        0,
        ...team.footballers.map((footballer) => {
          const history = footballer.history.find((h) => h.round === gw);
          return history ? parseFloat(history.expected_goals_conceded) : 0;
        }),
      );

      const teamXGS = team.footballers.reduce((sum, footballer) => {
        const history = footballer.history.find((h) => h.round === gw);
        return sum + (history ? parseFloat(history.expected_goals) : 0);
      }, 0);

      const goals = team.footballers.reduce((sum, footballer) => {
        const history = footballer.history.find((h) => h.round === gw);
        return sum + (history ? history.goals_scored : 0);
      }, 0);

      const goals_conceded = Math.max(
        ...team.footballers
          .map((footballer) => {
            const history = footballer.history.find((h) => h.round === gw);
            return history ? history.goals_conceded : 0;
          })
          .filter((x) => x !== null), // Remove null values
      );

      history.push({
        round: gw,
        teamXGC,
        teamXGS,
        goals,
        goals_conceded,
      });
    });

    return {
      ...team,
      history,
    };
  });
};
