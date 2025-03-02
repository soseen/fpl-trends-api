import { teams } from "@prisma/client";
import express, { Request, Response } from "express";
import cors from "cors";
import { fetchAllRawData } from "./fetchAllRawData";
import { fetchBootstrapStatic } from "./bootstrapStatic/fetchBootstrapStatic";
import { fetchFootballers } from "./footballers/fetchFootballers";
import { processRawData } from "./processRawData";
import { getFootballersWithHistoryAndFixtures } from "./footballers/getAllFootballersData";
import { getTeamsData } from "./teams/getTeamsData";
import { getBasicInfo } from "./fetch";
import { getEvents } from "./events/getEvents";

const app = express();
const PORT = process.env.PORT || 3000;

const corsOptions = {
  origin:
    process.env.NODE_ENV === "production"
      ? "https://your-production-domain.com"
      : "http://localhost:5000",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use(cors(corsOptions));

app.get("/api/footballersData", async (req: Request, res: Response) => {
  try {
    const footballers = await getFootballersWithHistoryAndFixtures();
    res.status(200).json(footballers);
  } catch (error: unknown) {
    console.error("Error querying ClickHouse:", error);
    res.status(500).json({ error: "Failed to fetch data." });
  }
});

app.get("/api/teamsData", async (req: Request, res: Response) => {
  try {
    const teams = await getTeamsData();
    res.status(200).json(teams);
  } catch (error: unknown) {
    console.error("Error querying ClickHouse:", error);
    res.status(500).json({ error: "Failed to fetch data." });
  }
});

app.get("/api/totalPlayersCount", async (req: Request, res: Response) => {
  try {
    const data = await getBasicInfo();
    res.status(200).json(data.totalPlayers);
  } catch (error: unknown) {
    console.error("Error querying ClickHouse:", error);
    res.status(500).json({ error: "Failed to fetch data." });
  }
});

app.get("/api/eventsData", async (req: Request, res: Response) => {
  try {
    const events = await getEvents();
    res.status(200).json(events);
  } catch (error: unknown) {
    console.error("Error querying ClickHouse:", error);
    res.status(500).json({ error: "Failed to fetch data." });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
