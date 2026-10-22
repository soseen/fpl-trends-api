import pg from "pg";

// A separate, small pool protects serving reads from worker connection queues.
// Deadlines apply in PostgreSQL, including after an HTTP client disconnects.
let pool: pg.Pool | undefined;
export const readDatabase = (): pg.Pool => {
  if (pool) return pool;
  pool = new pg.Pool({
    connectionString:
      process.env["ANALYTICS_READ_DATABASE_URL"] ?? process.env["DATABASE_URL"],
    max: 4,
    connectionTimeoutMillis: 1500,
    idleTimeoutMillis: 30_000,
    statement_timeout: 2000,
    lock_timeout: 500,
    application_name: "fpl-analytics-read",
  });
  pool.on("error", (error: Error) =>
    console.error(
      JSON.stringify({
        event: "analytics_idle_connection_error",
        message: error.message,
      }),
    ),
  );
  return pool;
};
export const closeReadDatabase = async (): Promise<void> => {
  await pool?.end();
  pool = undefined;
};
