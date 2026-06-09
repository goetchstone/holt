// /app/src/lib/requestLog.ts
//
// Lightweight request logging for API routes. Logs method, path, status code,
// duration, and authenticated user (if available). Output goes to stdout so
// Docker captures it in container logs.

import type { NextApiRequest, NextApiResponse } from "next";

interface LogEntry {
  ts: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  user?: string;
  ip?: string;
}

function getClientIp(req: NextApiRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}

function getUserEmail(req: NextApiRequest): string | undefined {
  // Session is attached by NextAuth middleware when available.
  // We read it from the request without an extra DB call.
  const session = (req as any).__nextauth?.session;
  return session?.user?.email ?? undefined;
}

function formatEntry(entry: LogEntry): string {
  const parts = [
    entry.ts,
    entry.method.padEnd(6),
    entry.status.toString(),
    `${entry.ms}ms`.padStart(7),
    entry.path,
  ];
  if (entry.user) parts.push(`[${entry.user}]`);
  return parts.join(" ");
}

// Wraps a Next.js API handler to log request/response metadata.
// Compose with requireAuth: withLogging(requireAuth(handler))
export function withLogging(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void | NextApiResponse>,
) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const start = Date.now();

    // Intercept res.end to capture status code after handler completes
    const originalEnd = res.end.bind(res);
    let logged = false;

    const logOnce = () => {
      if (logged) return;
      logged = true;
      const entry: LogEntry = {
        ts: new Date().toISOString(),
        method: req.method ?? "?",
        path: req.url ?? "/",
        status: res.statusCode,
        ms: Date.now() - start,
        user: getUserEmail(req),
        ip: getClientIp(req),
      };

      // Slow request threshold: warn on anything over 5 seconds
      const line = formatEntry(entry);
      if (entry.ms > 5000) {
        console.warn(`SLOW ${line}`);
      } else if (entry.status >= 500) {
        console.error(`ERR  ${line}`);
      } else if (process.env.NODE_ENV !== "production" || entry.status >= 400) {
        // In production, only log errors and warnings to keep noise down.
        // In dev, log everything.
        console.log(entry.status >= 400 ? `WARN ${line}` : `     ${line}`);
      }
    };

    res.end = ((...args: any[]) => {
      logOnce();
      return originalEnd(...args);
    }) as typeof res.end;

    try {
      return await handler(req, res);
    } catch (err) {
      logOnce();
      throw err;
    }
  };
}
