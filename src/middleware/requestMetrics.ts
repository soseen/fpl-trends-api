import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
export const requestMetrics = (
  _req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const id = randomUUID(),
    started = performance.now();
  res.setHeader("X-Request-ID", id);
  res.once("finish", () =>
    console.info(
      JSON.stringify({
        event: "http_request",
        requestId: id,
        method: _req.method,
        route:
          (_req.route as { path?: string } | undefined)?.path ??
          _req.path.replace(/\d+/g, ":id"),
        status: res.statusCode,
        durationMs: Math.round(performance.now() - started),
      }),
    ),
  );
  next();
};
