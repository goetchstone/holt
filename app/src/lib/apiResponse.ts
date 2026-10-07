// /app/src/lib/apiResponse.ts
//
// Standardized API response helpers. Every API route should use these
// instead of raw res.status().json() to ensure consistent response
// shapes across the entire application.
//
// Success responses: { data: T }
// Error responses:   { error: string, code?: string, details?: unknown }
// List responses:    { data: T[], total: number, page: number, limit: number }

import type { NextApiResponse } from "next";
import { logError } from "@/lib/logger";

interface ErrorPayload {
  error: string;
  code?: string;
  details?: unknown;
}

// Application-level error with HTTP status code.
// Throw this from service functions; the API handler catches and responds.
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function success<T>(res: NextApiResponse, data: T, status = 200): void {
  res.status(status).json(data);
}

export function created<T>(res: NextApiResponse, data: T): void {
  res.status(201).json(data);
}

export function noContent(res: NextApiResponse): void {
  res.status(204).end();
}

export function error(res: NextApiResponse, status: number, message: string, code?: string): void {
  const payload: ErrorPayload = { error: message };
  if (code) payload.code = code;
  res.status(status).json(payload);
}

export function badRequest(res: NextApiResponse, message: string): void {
  error(res, 400, message, "BAD_REQUEST");
}

export function unauthorized(res: NextApiResponse): void {
  error(res, 401, "Unauthorized", "UNAUTHORIZED");
}

export function forbidden(res: NextApiResponse, message = "Forbidden"): void {
  error(res, 403, message, "FORBIDDEN");
}

export function notFound(res: NextApiResponse, entity = "Resource"): void {
  error(res, 404, `${entity} not found`, "NOT_FOUND");
}

export function conflict(res: NextApiResponse, message: string): void {
  error(res, 409, message, "CONFLICT");
}

export function methodNotAllowed(res: NextApiResponse, allowed: string[]): void {
  res.setHeader("Allow", allowed);
  error(res, 405, `Method not allowed. Use: ${allowed.join(", ")}`, "METHOD_NOT_ALLOWED");
}

// Catches ApiError and unknown errors, sends standardized response.
// Use as the catch block in API route handlers.
export function handleError(res: NextApiResponse, err: unknown, context?: string): void {
  if (err instanceof ApiError) {
    error(res, err.statusCode, err.message, err.code);
    return;
  }

  const message = err instanceof Error ? err.message : "Internal server error";
  logError(context ?? "Unhandled API error", err);
  error(res, 500, message, "INTERNAL_ERROR");
}
