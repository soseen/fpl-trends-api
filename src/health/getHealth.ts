import type { Request, Response } from "express";
import { prisma } from "../database/client.js";

export async function getHealth(_req: Request, res: Response): Promise<void> {
  const t0 = Date.now();
  let dbOk = false;
  let dbLatencyMs: number | null = null;
  try {
    const dbT0 = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Date.now() - dbT0;
    dbOk = true;
  } catch (error: unknown) {
    console.error("Health check DB ping failed:", error);
  }
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? "ok" : "degraded",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    db: dbOk ? { status: "up", latencyMs: dbLatencyMs } : { status: "down" },
    elapsedMs: Date.now() - t0,
  });
}
