import axios, { type AxiosInstance } from "axios";
import { AnalyticsError } from "../analytics/errors.js";
let blockedUntil = 0;
export const retryAfterMilliseconds = (
  value: unknown,
  now = Date.now(),
): number => {
  const seconds =
    typeof value === "number" || typeof value === "string"
      ? Number(value)
      : NaN;
  const parsedDate = typeof value === "string" ? Date.parse(value) : NaN;
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Number.isFinite(parsedDate)
      ? parsedDate - now
      : 60000;
  return Math.max(1000, Math.min(3600000, delay));
};
export const fplBackoffRemaining = (): number =>
  Math.max(0, blockedUntil - Date.now());
// Share a cooldown across clients so distinct manager jobs respect Retry-After.
export const observeFplBackoff = (client: AxiosInstance): void => {
  client.interceptors.request.use((config) => {
    if (fplBackoffRemaining() > 0)
      throw new AnalyticsError(
        "upstream_rate_limited",
        "FPL is limiting requests. Analysis will retry shortly.",
      );
    return config;
  });
  client.interceptors.response.use(
    (response) => response,
    (error: unknown) => {
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        blockedUntil = Math.max(
          blockedUntil,
          Date.now() +
            retryAfterMilliseconds(error.response.headers["retry-after"]),
        );
        console.warn(
          JSON.stringify({
            event: "fpl_cooldown",
            retryInMs: fplBackoffRemaining(),
          }),
        );
      }
      throw error;
    },
  );
};
