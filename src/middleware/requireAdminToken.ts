import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";

export function requireAdminToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = process.env["ADMIN_TOKEN"];
  if (!expected) {
    console.error("ADMIN_TOKEN not set; refusing privileged request");
    res.status(503).json({ error: "Server not configured." });
    return;
  }
  const header = req.header("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }
  next();
}
