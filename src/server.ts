import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import { analyticsRouter, analyticsErrorHandler } from "./analytics/http.js";
import { requestMetrics } from "./middleware/requestMetrics.js";
import { analyticsReadiness } from "./analytics/health.js";
import { getFootballersWithHistoryAndFixtures } from "./footballers/getAllFootballersData.js";
import { getTeamsData } from "./teams/getTeamsData.js";
import { getBasicInfo } from "./fetch.js";
import { getEvents } from "./events/getEvents.js";
import { populateDatabase } from "./database/populateDatabase.js";
import { cachedJson, invalidateCache } from "./cache/responseCache.js";
import { requireAdminToken } from "./middleware/requireAdminToken.js";
import { apiRateLimit } from "./middleware/rateLimit.js";
import { getHealth } from "./health/getHealth.js";
import { getPlayerImage } from "./images/playerImageProxy.js";
import {
  getSeasonArchiveDataset,
  getSeasonCatalog,
  normalizeSeason,
  SeasonArchiveNotFoundError,
  type SeasonArchiveDataset,
} from "./database/seasonArchive.js";
import { getStoredSeason } from "./database/seasonManager.js";

const app = express();
const PORT = parseInt(process.env["PORT"] as string) || 3000;

// nginx terminates TLS and proxies to 127.0.0.1:3000 in production.
// "loopback" trusts X-Forwarded-For only when the immediate hop is on the
// loopback interface (i.e. the local nginx), so a remote attacker can't
// spoof their source IP to bypass per-IP rate limits.
app.set("trust proxy", "loopback");

app.use(requestMetrics);
app.use(helmet());
app.use(compression());
app.use(express.json());

// Comma-separated list of allowed origins, e.g.
//   ALLOWED_ORIGINS="https://fpltrends.live,https://www.fpltrends.live"
// Falls back to the production domain if unset, so a missing env var on a
// fresh server doesn't accidentally open CORS to everyone.
const envOrigins = (process.env["ALLOWED_ORIGINS"] ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const allowedOrigins =
  envOrigins.length > 0
    ? envOrigins
    : ["https://fpltrends.live", "https://www.fpltrends.live"];

const corsOptions = {
  origin:
    process.env["NODE_ENV"] === "production"
      ? allowedOrigins
      : [...allowedOrigins, "http://localhost:5000", "http://localhost:5050"],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use(cors(corsOptions));

app.get("/api/player-image/:size/:code", getPlayerImage);

app.use("/api", apiRateLimit);

app.get("/api/health", getHealth);
app.get("/api/health/live", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});
app.get("/api/health/ready", analyticsReadiness);

app.get("/api/seasons", async (_req: Request, res: Response) => {
  try {
    res.status(200).json(await getSeasonCatalog());
  } catch (error: unknown) {
    console.error("Error fetching season catalog:", error);
    res.status(500).json({ error: "Failed to fetch season catalog." });
  }
});

type ParsedSeasonRequest =
  | { valid: true; season: string | null }
  | { valid: false };

const parseRequestedSeason = (
  req: Request,
  res: Response,
): ParsedSeasonRequest => {
  const rawSeason = req.query["season"];
  if (rawSeason === undefined) return { valid: true, season: null };

  const season = normalizeSeason(rawSeason);
  if (!season) {
    res.status(400).json({ error: "Invalid season. Expected YYYY-YY." });
    return { valid: false };
  }

  return { valid: true, season };
};

const loadSeasonAwareData = async (
  season: string | null,
  dataset: SeasonArchiveDataset,
  currentLoader: () => Promise<unknown>,
): Promise<unknown> => {
  if (!season || season === (await getStoredSeason())) {
    return currentLoader();
  }
  return getSeasonArchiveDataset(season, dataset);
};

const handleBulkDataError = (
  res: Response,
  error: unknown,
  message: string,
): void => {
  if (error instanceof SeasonArchiveNotFoundError) {
    res.status(404).json({ error: error.message });
    return;
  }
  console.error(message, error);
  res.status(500).json({ error: "Failed to fetch data." });
};

app.get("/api/footballersData", async (req: Request, res: Response) => {
  const parsed = parseRequestedSeason(req, res);
  if (!parsed.valid) return;

  try {
    await cachedJson(
      req,
      res,
      `footballersData:${parsed.season ?? "current"}`,
      () =>
        loadSeasonAwareData(
          parsed.season,
          "footballers_data",
          getFootballersWithHistoryAndFixtures,
        ),
    );
  } catch (error: unknown) {
    handleBulkDataError(res, error, "Error fetching footballers data:");
  }
});

app.get("/api/teamsData", async (req: Request, res: Response) => {
  const parsed = parseRequestedSeason(req, res);
  if (!parsed.valid) return;

  try {
    await cachedJson(req, res, `teamsData:${parsed.season ?? "current"}`, () =>
      loadSeasonAwareData(parsed.season, "teams_data", getTeamsData),
    );
  } catch (error: unknown) {
    handleBulkDataError(res, error, "Error fetching teams data:");
  }
});

app.get("/api/totalPlayersCount", async (req: Request, res: Response) => {
  const parsed = parseRequestedSeason(req, res);
  if (!parsed.valid) return;

  try {
    await cachedJson(
      req,
      res,
      `totalPlayersCount:${parsed.season ?? "current"}`,
      () =>
        loadSeasonAwareData(parsed.season, "total_players", async () => {
          const data = await getBasicInfo();
          return data.totalPlayers;
        }),
    );
  } catch (error: unknown) {
    handleBulkDataError(res, error, "Error fetching total players count:");
  }
});

app.get("/api/eventsData", async (req: Request, res: Response) => {
  const parsed = parseRequestedSeason(req, res);
  if (!parsed.valid) return;

  try {
    await cachedJson(req, res, `eventsData:${parsed.season ?? "current"}`, () =>
      loadSeasonAwareData(parsed.season, "events_data", getEvents),
    );
  } catch (error: unknown) {
    handleBulkDataError(res, error, "Error fetching events data:");
  }
});

app.get(
  "/api/populate",
  requireAdminToken,
  async (_req: Request, res: Response) => {
    try {
      await populateDatabase();
      invalidateCache();
      res.status(200).json({ success: true });
    } catch (error: unknown) {
      console.error("Error populating database:", error);
      res.status(500).json({ error: "Failed to populate database." });
    }
  },
);

app.use("/api/manager", analyticsRouter);
app.use(analyticsErrorHandler);

const server = app.listen(PORT, () => {
  console.info(`Server is running on port ${PORT}`);
});

if (process.env["NODE_ENV"] === "production") {
  process.on("SIGTERM", () => {
    console.info("Shutting down gracefully...");
    server.close(() => {
      console.info("Process terminated.");
    });
  });

  process.on("SIGINT", () => {
    console.info("Interrupted! Shutting down...");
    server.close(() => {
      console.info("Server stopped.");
    });
  });
}
