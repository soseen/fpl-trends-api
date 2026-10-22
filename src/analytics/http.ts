import { createHash, randomUUID } from "node:crypto";
import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod";
import { readDatabase } from "./readDatabase.js";
import { errorInfo } from "./errors.js";
import {
  ReadyAnalysisSchema,
  type AnalysisResponse,
} from "./contracts.generated.js";
import { CALCULATION_VERSION } from "./model.js";

const rangeSchema = z
  .object({
    entry: z.coerce.number().int().min(1).max(20_000_000),
    start: z.coerce.number().int().min(1).max(38),
    end: z.coerce.number().int().min(1).max(38),
  })
  .refine((r) => r.start <= r.end);
const router = Router();
const serve = async (req: Request, res: Response): Promise<void> => {
  const parsed = rangeSchema.safeParse({
    entry: req.params["id"],
    start: req.query["start"] ?? 1,
    end: req.query["end"],
  });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid manager ID or gameweek range." });
    return;
  }
  const { entry, start, end } = parsed.data,
    db = readDatabase();
  const state = (
    await db.query<{
      season: string;
      bulk_revision: string;
      latest_gw: number;
    }>(
      `SELECT (SELECT value FROM app_metadata WHERE key='current_season') AS season,(SELECT value FROM app_metadata WHERE key='bulk_data_refresh_version') AS bulk_revision,(SELECT MAX(id) FROM events) AS latest_gw`,
    )
  ).rows[0];
  if (!state?.season) {
    res.status(503).json({
      state: "failed",
      error: {
        code: "season_unavailable",
        message: "Season data is not available yet.",
        retryable: true,
      },
    } satisfies AnalysisResponse);
    return;
  }
  if (end > state.latest_gw) {
    res
      .status(400)
      .json({ error: "The selected range includes an unplayed gameweek." });
    return;
  }
  const versions = (
    await db.query<{ id: string }>(
      `SELECT b.id FROM analytics_publications p JOIN analytics_benchmarks b ON b.id=p.benchmark_id WHERE p.season=$1 AND p.gw BETWEEN 1 AND $2 AND b.calculation_version=$3 ORDER BY p.gw`,
      [state.season, end, CALCULATION_VERSION],
    )
  ).rows;
  const revision = createHash("sha256")
    .update(
      `${CALCULATION_VERSION}:${state.season}:${state.bulk_revision ?? "unknown"}:${versions.map((v) => v.id).join(":")}`,
    )
    .digest("hex");
  const key = `manager:${state.season}:${entry}:${start}:${end}:${revision}`;
  const row = (
    await db.query<{ payload: unknown; revision: string; fresh: boolean }>(
      `SELECT payload,revision,expires_at>now() AS fresh FROM analytics_manager_results WHERE season=$1 AND entry_id=$2 AND start_gw=$3 AND end_gw=$4`,
      [state.season, entry, start, end],
    )
  ).rows[0];
  const ready = row ? ReadyAnalysisSchema.parse(row.payload) : null;
  const stale =
    !row?.fresh || row.revision !== revision || req.query["refresh"] === "true";
  res.setHeader("Cache-Control", "no-store");
  if (stale || req.query["refresh"] === "true") {
    try {
      await db.query(
        `INSERT INTO analytics_jobs(id,key,kind,season,entry_id,start_gw,end_gw) SELECT $1::uuid,$2::text,'manager',$3::text,$4::int,$5::int,$6::int
    WHERE NOT EXISTS(SELECT 1 FROM analytics_jobs WHERE status IN ('queued','running') OFFSET 1999 LIMIT 1)
    AND (SELECT COUNT(*) FROM analytics_jobs WHERE season=$3::text AND entry_id=$4::int AND status IN ('queued','running'))<3
    ON CONFLICT(key) DO UPDATE SET status='queued',attempts=0,error_code=null,error_message=null,available_at=now(),updated_at=now()
    WHERE analytics_jobs.status IN ('succeeded','failed') AND analytics_jobs.available_at<=now()`,
        [randomUUID(), key, state.season, entry, start, end],
      );
    } catch (error) {
      if (!ready) throw error;
      const info = errorInfo(error);
      console.error(
        JSON.stringify({ event: "analytics_refresh_enqueue_failed", ...info }),
      );
      res.status(200).json({
        ...ready,
        stale: true,
        sectionErrors: { ...ready.sectionErrors, refresh: info },
      } satisfies AnalysisResponse);
      return;
    }
  }
  const job = (
    await db.query<{
      status: string;
      error_code: string | null;
      error_message: string | null;
      stalled: boolean;
    }>(
      `SELECT status,error_code,error_message,(status='queued' AND updated_at<now()-interval '3 minutes') OR (status='running' AND heartbeat_at<now()-interval '90 seconds') AS stalled FROM analytics_jobs WHERE key=$1`,
      [key],
    )
  ).rows[0];
  if (ready) {
    const refreshError =
      job?.stalled || job?.status === "failed" || (stale && !job);
    res.status(200).json({
      ...ready,
      sectionErrors: refreshError
        ? {
            ...ready.sectionErrors,
            refresh: {
              code: job?.error_code ?? "refresh_delayed",
              message:
                job?.error_message ??
                "The refresh is delayed. Saved results are still available.",
              retryable: true,
            },
          }
        : ready.sectionErrors,
      stale: stale || job?.status === "queued" || job?.status === "running",
    } satisfies AnalysisResponse);
    return;
  }
  if (!job) {
    res.status(503).json({
      state: "failed",
      error: {
        code: "queue_busy",
        message: "Analysis preparation is busy. Please retry shortly.",
        retryable: true,
      },
    } satisfies AnalysisResponse);
    return;
  }
  if (job?.stalled) {
    res.status(503).json({
      state: "failed",
      error: {
        code: "preparation_delayed",
        message: "Analysis preparation is delayed. Please retry shortly.",
        retryable: true,
      },
    } satisfies AnalysisResponse);
    return;
  }
  if (job?.status === "failed") {
    res.status(job.error_code === "manager_not_found" ? 404 : 503).json({
      state: "failed",
      error: {
        code: job.error_code ?? "analytics_failed",
        message: job.error_message ?? "Analytics preparation failed.",
        retryable: job.error_code !== "manager_not_found",
      },
    } satisfies AnalysisResponse);
    return;
  }
  res.setHeader("Retry-After", "2");
  res.status(202).json({
    state: "preparing",
    message:
      versions.length < end
        ? "Preparing gameweek benchmarks."
        : "Preparing your manager analysis.",
    retryAfter: 2,
    jobStatus: job?.status === "running" ? "running" : "queued",
  } satisfies AnalysisResponse);
};
router.get(
  "/:id/analysis",
  (req: Request, res: Response, next: NextFunction) => {
    void serve(req, res).catch(next);
  },
);
export const analyticsRouter = router;
export const analyticsErrorHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (res.headersSent) {
    _next(error);
    return;
  }
  const info = errorInfo(error);
  console.error(
    JSON.stringify({
      event: "analytics_http_failed",
      ...info,
      cause: error instanceof Error ? error.message : String(error),
    }),
  );
  res
    .status(info.status)
    .json({ state: "failed", error: info } satisfies AnalysisResponse);
};
