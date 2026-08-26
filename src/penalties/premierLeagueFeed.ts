import axios, { type AxiosRequestConfig } from "axios";
import { delay } from "../utils.js";

const FEED_ROOT = "https://footballapi.pulselive.com/football";
const PREMIER_LEAGUE_COMPETITION_ID = 1;
const MAX_RETRIES = 4;

type JsonObject = Record<string, unknown>;

export type PremierLeagueFixture = {
  id: number;
  fixtureCode: number;
  gameweek: number | null;
  homeTeamId: number;
  awayTeamId: number;
  goals: PremierLeaguePenaltyEvent[];
  playerTeams: Array<{ playerCode: number; teamId: number }>;
};

export type PremierLeaguePenaltyEvent = {
  type: "P" | "MP";
  personId: number;
  teamId: number;
};

export type CompetitionSeason = {
  id: number;
  season: string;
};

const object = (value: unknown, label: string): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`[penaltyFeed] Expected ${label} to be an object.`);
  }
  return value as JsonObject;
};

const array = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) {
    throw new Error(`[penaltyFeed] Expected ${label} to be an array.`);
  }
  return value;
};

const integer = (value: unknown, label: string): number => {
  if (!Number.isInteger(value)) {
    throw new Error(`[penaltyFeed] Expected ${label} to be an integer.`);
  }
  return value as number;
};

const content = (value: unknown, label: string): unknown[] => {
  if (Array.isArray(value)) return value;
  return array(object(value, label)["content"], `${label}.content`);
};

export const normalizeSeasonLabel = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const match = value.match(/(20\d{2})\s*[/-]\s*(20\d{2}|\d{2})/);
  if (!match?.[1] || !match[2]) return null;
  const start = Number(match[1]);
  const end = Number(match[2].length === 2 ? `20${match[2]}` : match[2]);
  if (end !== start + 1) return null;
  return `${start}-${String(end).slice(-2)}`;
};

export const parseOptaCode = (
  value: unknown,
  prefix: "g" | "p",
): number | null => {
  if (typeof value !== "string") return null;
  const match = value.match(new RegExp(`^${prefix}(\\d+)$`));
  return match?.[1] ? Number(match[1]) : null;
};

const feedGet = async <T>(
  path: string,
  config: AxiosRequestConfig = {},
): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get<T>(`${FEED_ROOT}${path}`, {
        ...config,
        headers: {
          Origin: "https://www.premierleague.com",
          "User-Agent": "FPL-Trends/1.0",
          ...config.headers,
        },
        timeout: 20_000,
      });
      return response.data;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) await delay(300 * 2 ** (attempt - 1));
    }
  }
  throw new Error(
    `[penaltyFeed] ${path} failed after ${MAX_RETRIES} attempts: ${(lastError as Error)?.message ?? "unknown error"}`,
  );
};

const seasonName = (row: JsonObject): string | null => {
  for (const key of ["label", "name", "description"]) {
    const normalized = normalizeSeasonLabel(row[key]);
    if (normalized) return normalized;
  }
  return null;
};

export const resolveCompetitionSeason = async (
  season: string,
): Promise<CompetitionSeason> => {
  const payload = await feedGet<unknown>(
    `/competitions/${PREMIER_LEAGUE_COMPETITION_ID}/compseasons`,
    { params: { page: 0, pageSize: 100 } },
  );
  const matches = content(payload, "competition seasons")
    .map((item) => object(item, "competition season"))
    .map((item) => ({
      id: integer(item["id"], "competition season id"),
      season: seasonName(item),
    }))
    .filter((item): item is CompetitionSeason => item.season !== null)
    .filter((item) => item.season === season);

  if (matches.length !== 1 || !matches[0]) {
    throw new Error(
      `[penaltyFeed] Expected one Premier League competition season for ${season}, found ${matches.length}.`,
    );
  }
  return matches[0];
};

const teamIds = (fixture: JsonObject): [number, number] => {
  const teams = array(fixture["teams"], "fixture.teams").map((value) => {
    const entry = object(value, "fixture team entry");
    const team = object(entry["team"], "fixture team");
    return integer(team["id"], "fixture team id");
  });
  if (teams.length !== 2 || teams[0] === undefined || teams[1] === undefined) {
    throw new Error("[penaltyFeed] Fixture did not contain exactly two teams.");
  }
  return [teams[0], teams[1]];
};

const eventTeamId = (event: JsonObject): number => {
  if (Number.isInteger(event["teamId"])) return event["teamId"] as number;
  const team = object(event["team"], "penalty event team");
  return integer(team["id"], "penalty event team id");
};

const parsePenaltyEvents = (
  value: unknown,
  allowedTypes: ReadonlySet<string>,
): PremierLeaguePenaltyEvent[] =>
  array(value, "fixture penalty events")
    .map((item) => object(item, "fixture event"))
    .filter((item) => allowedTypes.has(String(item["type"])))
    .map((item) => ({
      type: String(item["type"]) as "P" | "MP",
      personId: integer(item["personId"], "penalty event personId"),
      teamId: eventTeamId(item),
    }));

const parsePlayerTeams = (
  value: unknown,
): PremierLeagueFixture["playerTeams"] => {
  if (value === undefined) return [];
  return array(value, "fixture.teamLists").flatMap((item) => {
    const teamList = object(item, "fixture team list");
    const teamId = integer(teamList["teamId"], "fixture team list teamId");
    return ["lineup", "substitutes"].flatMap((field) =>
      array(teamList[field] ?? [], `fixture team list ${field}`).map(
        (entry) => {
          const player = object(entry, "fixture team-list player");
          const playerCode = parseOptaCode(
            object(player["altIds"], "fixture team-list player.altIds")["opta"],
            "p",
          );
          if (playerCode === null) {
            throw new Error(
              `[penaltyFeed] Fixture squad player on team ${teamId} has no Opta ID.`,
            );
          }
          return { playerCode, teamId };
        },
      ),
    );
  });
};

export const parsePremierLeagueFixture = (
  item: unknown,
  eventField: "goals" | "events",
  allowedTypes: ReadonlySet<string>,
): PremierLeagueFixture => {
  const fixture = object(item, "fixture");
  const altIds = object(fixture["altIds"], "fixture.altIds");
  const fixtureCode = parseOptaCode(altIds["opta"], "g");
  if (fixtureCode === null) {
    throw new Error("[penaltyFeed] Fixture is missing a valid Opta ID.");
  }
  const [homeTeamId, awayTeamId] = teamIds(fixture);
  const gameweekValue = object(fixture["gameweek"] ?? {}, "fixture.gameweek")[
    "gameweek"
  ];

  return {
    id: integer(fixture["id"], "fixture id"),
    fixtureCode,
    gameweek: Number.isInteger(gameweekValue)
      ? (gameweekValue as number)
      : null,
    homeTeamId,
    awayTeamId,
    goals: parsePenaltyEvents(fixture[eventField] ?? [], allowedTypes),
    playerTeams: parsePlayerTeams(fixture["teamLists"]),
  };
};

export const fetchCompletedFixtures = async (
  competitionSeasonId: number,
): Promise<PremierLeagueFixture[]> => {
  const payload = await feedGet<unknown>("/fixtures", {
    params: {
      comp: PREMIER_LEAGUE_COMPETITION_ID,
      compSeasons: competitionSeasonId,
      page: 0,
      pageSize: 500,
      sort: "desc",
      statuses: "C",
      altIds: true,
    },
  });
  return content(payload, "fixtures").map((fixture) =>
    parsePremierLeagueFixture(fixture, "goals", new Set(["P"])),
  );
};

export const fetchFixturePenaltyEvents = async (
  fixtureId: number,
): Promise<PremierLeagueFixture> => {
  const payload = await feedGet<unknown>(`/fixtures/${fixtureId}`, {
    params: {},
  });
  return parsePremierLeagueFixture(payload, "events", new Set(["P", "MP"]));
};

export const resolvePlayerOptaCode = async (
  playerId: number,
): Promise<number> => {
  const payload = object(
    await feedGet<unknown>(`/players/${playerId}`, {
      params: { altIds: true },
    }),
    "player",
  );
  const code = parseOptaCode(
    object(payload["altIds"], "player.altIds")["opta"],
    "p",
  );
  if (code === null) {
    throw new Error(`[penaltyFeed] Player ${playerId} has no valid Opta ID.`);
  }
  return code;
};
