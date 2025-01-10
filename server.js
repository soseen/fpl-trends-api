const express = require("express");
const { createClient } = require("@clickhouse/client");
// const axios = require("axios");
const { processAllPlayers } = require("./playersProcessor");

const app = express();
const PORT = 3000;

const clickhouse = createClient({
  url: "http://localhost:8123", 
  username: "default", 
  password: "", 
  database: "default", 
});



app.get("/api/fpl-data", async (req, res) => {
  try {
    console.log("PROCESSING PLAYERS!");
    processAllPlayers().catch((error) => {
      console.error("Error processing players:", error.message);
    });
    res.status(200);
  } catch (error) {
    console.error("Error querying ClickHouse:", error);
    res.status(500).json({ error: "Failed to fetch data." });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
