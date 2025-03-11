import express, { Request, Response } from "express";
import cors from "cors";
import { getFootballersWithHistoryAndFixtures } from "./footballers/getAllFootballersData.js";
import { getTeamsData } from "./teams/getTeamsData.js";
import { getBasicInfo } from "./fetch.js";
import { getEvents } from "./events/getEvents.js";
import compression from "compression";
import helmet from "helmet";
import { populateDatabase } from "./database/populateDatabase.js";

const app = express();
const PORT = parseInt(process.env.PORT as string) || 3000;

app.use(helmet());
app.use(compression());
app.use(express.json());

const allowedOrigins = ["https://fpltrends.app", "https://www.fpltrends.app"];

const corsOptions = {
  origin:
    process.env.NODE_ENV === "production"
      ? allowedOrigins
      : [...allowedOrigins, "http://localhost:5000"],
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
    console.error(
      "Encountered an error trying to execute a query function: ",
      error,
    );
    res.status(500).json({ error: "Failed to fetch data." });
  }
});

app.get("/api/teamsData", async (req: Request, res: Response) => {
  try {
    const teams = await getTeamsData();
    res.status(200).json(teams);
  } catch (error: unknown) {
    console.error(
      "Encountered an error trying to execute a query function: ",
      error,
    );
    res.status(500).json({ error: "Failed to fetch data." });
  }
});

app.get("/api/totalPlayersCount", async (req: Request, res: Response) => {
  try {
    const data = await getBasicInfo();
    res.status(200).json(data.totalPlayers);
  } catch (error: unknown) {
    console.error(
      "Encountered an error trying to execute a query function: ",
      error,
    );
    res.status(500).json({ error: "Failed to fetch data." });
  }
});

app.get("/api/eventsData", async (req: Request, res: Response) => {
  try {
    const events = await getEvents();
    res.status(200).json(events);
  } catch (error: unknown) {
    console.error(
      "Encountered an error trying to execute a query function: ",
      error,
    );
    res.status(500).json({ error: "Failed to fetch data." });
  }
});

app.get("/api/populate", async (req: Request, res: Response) => {
  try {
    await populateDatabase();
    res.status(200).json();
  } catch (error: unknown) {
    console.error(
      "Encountered an error trying to execute a query function: ",
      error,
    );
    res.status(500).json({ error: "Failed to fetch data." });
  }
});

const server = app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});

if (process.env.NODE_ENV === "production") {
  process.on("SIGTERM", () => {
    console.log("Shutting down gracefully...");
    server.close(() => {
      console.log("Process terminated.");
    });
  });

  process.on("SIGINT", () => {
    console.log("Interrupted! Shutting down...");
    server.close(() => {
      console.log("Server stopped.");
    });
  });
}
