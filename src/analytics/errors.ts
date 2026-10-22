import axios from "axios";
import { z } from "zod";
export class AnalyticsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = true,
    public readonly status = 503,
  ) {
    super(message);
    this.name = "AnalyticsError";
  }
}
export const errorInfo = (
  error: unknown,
): { code: string; message: string; retryable: boolean; status: number } => {
  if (error instanceof AnalyticsError)
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      status: error.status,
    };
  if (error instanceof z.ZodError)
    return {
      code: "source_schema_changed",
      message:
        "The data source returned an unexpected format. Saved results remain available.",
      retryable: false,
      status: 502,
    };
  if (axios.isAxiosError(error)) {
    if (error.response?.status === 404)
      return {
        code: "manager_not_found",
        message: "That FPL manager could not be found.",
        retryable: false,
        status: 404,
      };
    if (error.response?.status === 429)
      return {
        code: "upstream_rate_limited",
        message: "FPL is limiting requests. Analysis will retry shortly.",
        retryable: true,
        status: 503,
      };
    return {
      code: "upstream_unavailable",
      message:
        "FPL is temporarily unavailable. Saved results remain available.",
      retryable: true,
      status: 503,
    };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    [
      "P1001",
      "P1002",
      "P2024",
      "ECONNREFUSED",
      "57014",
      "53100",
      "53200",
      "53300",
      "ETIMEDOUT",
    ].includes(error.code)
  )
    return {
      code: "database_unavailable",
      message:
        "Analytics storage is temporarily unavailable. Please retry shortly.",
      retryable: true,
      status: 503,
    };
  if (typeof error === "object" && error !== null && "response" in error) {
    const response = error.response;
    if (
      typeof response === "object" &&
      response !== null &&
      "status" in response &&
      response.status === 404
    )
      return {
        code: "manager_not_found",
        message: "That FPL manager could not be found.",
        retryable: false,
        status: 404,
      };
  }
  return {
    code: "analytics_failed",
    message: "Analytics could not be updated. Please retry shortly.",
    retryable: true,
    status: 503,
  };
};
