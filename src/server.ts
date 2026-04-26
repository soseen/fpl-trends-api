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
import { cachedJson, invalidateCache } from "./cache/responseCache.js";

const app = express();
const PORT = parseInt(process.env["PORT"] as string) || 3000;

app.use(helmet());
app.use(compression());
app.use(express.json());

const allowedOrigins = ["https://fpltrends.live", "https://www.fpltrends.live"];

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
    await cachedJson(req, res, "footballersData", getFootballersWithHistoryAndFixtures);
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
