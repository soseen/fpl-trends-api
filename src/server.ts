import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import { getFootballersWithHistoryAndFixtures } from "./footballers/getAllFootballersData.js";
import { getTeamsData } from "./teams/getTeamsData.js";
import { getBasicInfo } from "./fetch.js";
import { getEvents } from "./events/getEvents.js";
import { populateDatabase } from "./database/populateDatabase.js";
import {
  cachedJson,
  cachedManagerJson,
  invalidateCache,
} from "./cache/responseCache.js";
import { getManagerSummary } from "./managers/getManagerSummary.js";
import { getRangeRank } from "./managers/getRangeRank.js";
import { getManagerTrajectory } from "./managers/getManagerTrajectory.js";
import { getManagerComparison } from "./managers/getManagerComparison.js";
import { getTeamImpact } from "./managers/getTeamImpact.js";
import { getManagerTransfers } from "./managers/getManagerTransfers.js";

const app = express();
const PORT = parseInt(process.env["PORT"] as string) || 3000;

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
      : [...allowedOrigins, "http://localhost:5000"],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use(cors(corsOptions));

app.get("/api/footballersData", async (req: Request, res: Response) => {
  try {
    await cachedJson(
      req,
      res,
      "footballersData",
      getFootballersWithHistoryAndFixtures,
    );
  } catch (error: unknown) {
    console.error("Error fetching footballers data:", error);
    res.status(500).json({ error: "Failed to fetch data." });
  }
});

app.get("/api/teamsData", async (req: Request, res: Response) => {
  try {
    await cachedJson(req, res, "teamsData", getTeamsData);
  } catch (error: unknown) {
    console.error("Error fetching teams data:", error);
    res.status(500).json({ error: "Failed to fetch data." });
  }
});

app.get("/api/totalPlayersCount", async (req: Request, res: Response) => {
  try {
    await cachedJson(req, res, "totalPlayersCount", async () => {
      const data = await getBasicInfo();
      return data.totalPlayers;
    });
  } catch (error: unknown) {
    console.error("Error fetching total players count:", error);
    res.status(500).json({ error: "Failed to fetch data." });
  }
});

app.get("/api/eventsData", async (req: Request, res: Response) => {
  try {
    await cachedJson(req, res, "eventsData", getEvents);
  } catch (error: unknown) {
    console.error("Error fetching events data:", error);
    res.status(500).json({ error: "Failed to fetch data." });
  }
});

app.get("/api/populate", async (_req: Request, res: Response) => {
  try {
    await populateDatabase();
    invalidateCache();
    res.status(200).json({ success: true });
  } catch (error: unknown) {
    console.error("Error populating database:", error);
    res.status(500).json({ error: "Failed to populate database." });
  }
});

const parseEntryId = (raw: string): number | null => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1 || id > 20_000_000) return null;
  return id;
};

app.get("/api/manager/:id/summary", async (req: Request, res: Response) => {
  const id = parseEntryId(req.params["id"] ?? "");
  if (id === null) {
    res.status(400).json({ error: "Invalid FPL ID." });
    return;
  }
  try {
    const data = await getManagerSummary(id);
    res.status(200).json(data);
  } catch (error: unknown) {
    const status = (error as { response?: { status?: number } }).response
      ?.status;
    if (status === 404) {
      res.status(404).json({ error: "Manager not found." });
      return;
    }
    console.error(`Error fetching manager ${id} summary:`, error);
    res.status(502).json({ error: "Failed to fetch manager from FPL." });
  }
});

app.get("/api/manager/:id/trajectory", async (req: Request, res: Response) => {
  const id = parseEntryId(req.params["id"] ?? "");
  if (id === null) {
    res.status(400).json({ error: "Invalid FPL ID." });
    return;
  }
  try {
    const data = await getManagerTrajectory(id);
    res.status(200).json(data);
  } catch (error: unknown) {
    const status = (error as { response?: { status?: number } }).response
      ?.status;
    if (status === 404) {
      res.status(404).json({ error: "Manager not found." });
      return;
    }
    console.error(`Error fetching trajectory for ${id}:`, error);
    res.status(502).json({ error: "Failed to fetch manager from FPL." });
  }
});

app.get("/api/manager/:id/range-rank", async (req: Request, res: Response) => {
  const id = parseEntryId(req.params["id"] ?? "");
  if (id === null) {
    res.status(400).json({ error: "Invalid FPL ID." });
    return;
  }
  const start = Number(req.query["start"]);
  const end = Number(req.query["end"]);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < start ||
    end > 38
  ) {
    res.status(400).json({ error: "Invalid gameweek range." });
    return;
  }
  try {
    await cachedManagerJson(req, res, "range-rank", id, start, end, () =>
      getRangeRank(id, start, end),
    );
  } catch (error: unknown) {
    const status = (error as { response?: { status?: number } }).response
      ?.status;
    if (status === 404) {
      res.status(404).json({ error: "Manager not found." });
      return;
    }
    console.error(`Error computing range rank for ${id}:`, error);
    res.status(500).json({ error: "Failed to compute range rank." });
  }
});

app.get("/api/manager/:id/team-impact", async (req: Request, res: Response) => {
  const id = parseEntryId(req.params["id"] ?? "");
  if (id === null) {
    res.status(400).json({ error: "Invalid FPL ID." });
    return;
  }
  const start = Number(req.query["start"]);
  const end = Number(req.query["end"]);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < start ||
    end > 38
  ) {
    res.status(400).json({ error: "Invalid gameweek range." });
    return;
  }
  try {
    await cachedManagerJson(req, res, "team-impact", id, start, end, () =>
      getTeamImpact(id, start, end),
    );
  } catch (error: unknown) {
    const status = (error as { response?: { status?: number } }).response
      ?.status;
    if (status === 404) {
      res.status(404).json({ error: "Manager not found." });
      return;
    }
    console.error(`Error computing team impact for ${id}:`, error);
    res.status(500).json({ error: "Failed to compute team impact." });
  }
});

app.get("/api/manager/:id/transfers", async (req: Request, res: Response) => {
  const id = parseEntryId(req.params["id"] ?? "");
  if (id === null) {
    res.status(400).json({ error: "Invalid FPL ID." });
    return;
  }
  const start = Number(req.query["start"]);
  const end = Number(req.query["end"]);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < start ||
    end > 38
  ) {
    res.status(400).json({ error: "Invalid gameweek range." });
    return;
  }
  try {
    await cachedManagerJson(req, res, "transfers", id, start, end, () =>
      getManagerTransfers(id, start, end),
    );
  } catch (error: unknown) {
    const status = (error as { response?: { status?: number } }).response
      ?.status;
    if (status === 404) {
      res.status(404).json({ error: "Manager not found." });
      return;
    }
    console.error(`Error computing transfers for ${id}:`, error);
    res.status(500).json({ error: "Failed to compute transfers." });
  }
});

app.get("/api/manager/:id/comparison", async (req: Request, res: Response) => {
  const id = parseEntryId(req.params["id"] ?? "");
  if (id === null) {
    res.status(400).json({ error: "Invalid FPL ID." });
    return;
  }
  const start = Number(req.query["start"]);
  const end = Number(req.query["end"]);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < start ||
    end > 38
  ) {
    res.status(400).json({ error: "Invalid gameweek range." });
    return;
  }
  try {
    await cachedManagerJson(req, res, "comparison", id, start, end, () =>
      getManagerComparison(id, start, end),
    );
  } catch (error: unknown) {
    const status = (error as { response?: { status?: number } }).response
      ?.status;
    if (status === 404) {
      res.status(404).json({ error: "Manager not found." });
      return;
    }
    console.error(`Error computing comparison for ${id}:`, error);
    res.status(500).json({ error: "Failed to compute comparison." });
  }
});

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
