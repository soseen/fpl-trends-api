import pg from "pg";

// A dedicated session owns the lock across both HTTP and cron callers,
// including raw-file fetching before the publication guard is raised.
export const withBulkRefreshLock = async (
  run: () => Promise<void>,
): Promise<boolean> => {
  const client = new pg.Client({
    connectionString: process.env["DATABASE_URL"],
    connectionTimeoutMillis: 5000,
    application_name: "fpl-trends-bulk-refresh",
  });
  try {
    await client.connect();
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(871970202,1) AS locked",
    );
    if (!result.rows[0]?.locked) {
      console.info(
        JSON.stringify({
          event: "bulk_refresh_skipped",
          reason: "already_running",
        }),
      );
      return false;
    }
    await run();
    return true;
  } finally {
    // Closing this session releases its advisory lock, including on failure.
    await client.end();
  }
};
