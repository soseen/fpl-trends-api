import express, { Request, Response } from "express";
import { createClient } from "@clickhouse/client";
import { processAllPlayers } from "./playersProcessor";

const app = express();
const PORT = 3000;

const clickhouse = createClient({
  url: "http://localhost:8123",
  username: "default",
  password: "",
  database: "default",
});

app.get("/api/fpl-data", async (req: Request, res: Response) => {
  try {
    console.log("PROCESSING PLAYERS!");
    await processAllPlayers(); // Ensure you `await` this async call.
    res.status(200).json({ message: "Players processed successfully!" });
  } catch (error: unknown) {
    console.error("Error querying ClickHouse:", error);
    res.status(500).json({ error: "Failed to fetch data." });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
