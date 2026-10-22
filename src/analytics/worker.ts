import "dotenv/config";
import { fileURLToPath } from "node:url";
import { prisma } from "../database/client.js";
import { buildBenchmark } from "./buildBenchmark.js";
import { claimJob, finishJob, heartbeat } from "./store.js";
import { errorInfo } from "./errors.js";
import { prepareManager } from "./managerAnalysis.js";
import { delay } from "../utils.js";
import { maintainAnalytics } from "./maintenance.js";
import { statfsSync } from "node:fs";
import { fplBackoffRemaining } from "../managers/fplBackoff.js";

export const runOneJob = async (): Promise<boolean> => {
  const job = await claimJob(fplBackoffRemaining() > 0);
  if (!job) return false;
  const started = Date.now();
  let leaseLost = false;
  const timer = setInterval(() => {
    void heartbeat(job)
      .then((ok) => {
        if (!ok) leaseLost = true;
      })
      .catch((error) =>
        console.error(
          JSON.stringify({
            event: "analytics_heartbeat_failed",
            job: job.id,
            cause: String(error),
          }),
        ),
      );
  }, 20_000);
  try {
    if (job.attempts > 3) throw new Error("Job exceeded its retry budget");
    if (job.kind === "benchmark") {
      const disk = statfsSync(process.cwd());
      if (disk.bavail * disk.bsize < 4 * 1024 ** 3)
        throw new Error(
          "Benchmark build withheld: less than 4 GiB disk headroom",
        );
      await buildBenchmark(job.season, job.end_gw, job);
    } else await prepareManager(job);
    if (leaseLost) throw new Error("Worker lease was lost");
    await finishJob(job);
    console.info(
      JSON.stringify({
        event: "analytics_job_succeeded",
        job: job.id,
        kind: job.kind,
        durationMs: Date.now() - started,
      }),
    );
  } catch (error) {
    const info = errorInfo(error);
    await finishJob(job, info);
    console.error(
      JSON.stringify({
        event: "analytics_job_failed",
        job: job.id,
        kind: job.kind,
        durationMs: Date.now() - started,
        ...info,
        cause: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    clearInterval(timer);
  }
  return true;
};
const entryPath = fileURLToPath(import.meta.url);
if (
  process.argv[1] === entryPath ||
  process.env["pm_exec_path"] === entryPath
) {
  let stopping = false;
  process.once("SIGTERM", () => {
    stopping = true;
  });
  process.once("SIGINT", () => {
    stopping = true;
  });
  let lastHeartbeat = 0,
    lastMaintenance = 0;
  try {
    do {
      if (Date.now() - lastHeartbeat > 20_000) {
        await prisma.$executeRaw`INSERT INTO app_metadata(key,value) VALUES ('analytics_worker_heartbeat',${new Date().toISOString()}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
        lastHeartbeat = Date.now();
      }
      const worked = await runOneJob();
      if (process.argv.includes("--once")) break;
      if (Date.now() - lastMaintenance > 60_000) {
        await maintainAnalytics();
        lastMaintenance = Date.now();
      }
      if (!worked) await delay(1000);
    } while (!stopping);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
