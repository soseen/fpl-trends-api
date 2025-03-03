import express from "express";
import cors from "cors";
import { getFootballersWithHistoryAndFixtures } from "./footballers/getAllFootballersData";
import { getTeamsData } from "./teams/getTeamsData";
import { getBasicInfo } from "./fetch";
import { getEvents } from "./events/getEvents";
const app = express();
const PORT = process.env.PORT || 3000;
const corsOptions = {
    origin: process.env.NODE_ENV === "production"
        ? "https://fpltrends.app"
        : "http://localhost:5000",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
};
app.use(cors(corsOptions));
app.get("/api/footballersData", async (req, res) => {
    try {
        const footballers = await getFootballersWithHistoryAndFixtures();
        res.status(200).json(footballers);
    }
    catch (error) {
        console.error("Encountered an error trying to execute a query function: ", error);
        res.status(500).json({ error: "Failed to fetch data." });
    }
});
app.get("/api/teamsData", async (req, res) => {
    try {
        const teams = await getTeamsData();
        res.status(200).json(teams);
    }
    catch (error) {
        console.error("Encountered an error trying to execute a query function: ", error);
        res.status(500).json({ error: "Failed to fetch data." });
    }
});
app.get("/api/totalPlayersCount", async (req, res) => {
    try {
        const data = await getBasicInfo();
        res.status(200).json(data.totalPlayers);
    }
    catch (error) {
        console.error("Encountered an error trying to execute a query function: ", error);
        res.status(500).json({ error: "Failed to fetch data." });
    }
});
app.get("/api/eventsData", async (req, res) => {
    try {
        const events = await getEvents();
        res.status(200).json(events);
    }
    catch (error) {
        console.error("Encountered an error trying to execute a query function: ", error);
        res.status(500).json({ error: "Failed to fetch data." });
    }
});
app.get("/api/test", async (req, res) => {
    try {
        const test = [{ id: 1, value: "test" }];
        res.status(200).json(test);
    }
    catch (error) {
        console.error("Encountered an error trying to execute a query function: ", error);
        res.status(500).json({ error: "Failed to fetch data." });
    }
});
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
