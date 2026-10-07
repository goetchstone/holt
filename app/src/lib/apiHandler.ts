// /app/src/lib/apiHandler.ts
//
// Wraps API route handlers with consistent error handling, method routing,
// and structured logging. New routes should use this; existing routes can
// be migrated incrementally.

import type { NextApiRequest, NextApiResponse } from "next";
import { logger } from "@/lib/logger";

export class ValidationError extends Error {
  public readonly status = 400;
  public readonly details: Record<string, string[]>;

  constructor(message: string, details: Record<string, string[]> = {}) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
  }
}

type HandlerFn = (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void;

type HandlerMap = {
  [method: string]: HandlerFn;
};

/**
 * Wrap an API route with method routing and error handling.
 *
 * Usage:
 *   export default apiHandler({
 *     GET: async (req, res) => { ... },
 *     POST: async (req, res) => { ... },
 *   });
 */
export function apiHandler(handlers: HandlerMap) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const method = req.method ?? "UNKNOWN";
    const fn = handlers[method];

    if (!fn) {
      res.setHeader("Allow", Object.keys(handlers).join(", "));
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      await fn(req, res);
    } catch (err: unknown) {
      if (err instanceof ValidationError) {
        return res.status(400).json({
          error: err.message,
          details: Object.keys(err.details).length > 0 ? err.details : undefined,
        });
      }

      const message = err instanceof Error ? err.message : "Unknown error";
      const stack = err instanceof Error ? err.stack : undefined;

      logger.error("Unhandled API error", {
        path: req.url,
        method,
        error: message,
        stack,
      });

      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  };
}
