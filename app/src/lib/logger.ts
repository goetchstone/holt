// /app/src/lib/logger.ts
//
// Structured logger. JSON output in production (for Docker log aggregation),
// human-readable in development. No external dependencies.

type LogLevel = "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
}

const isProduction = process.env.NODE_ENV === "production";

function formatDev(entry: LogEntry): string {
  const { timestamp, level, message, ...context } = entry;
  const prefix = `[${timestamp}] ${level.toUpperCase()}`;
  const contextStr = Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : "";
  return `${prefix}: ${message}${contextStr}`;
}

function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...context,
  };

  const output = isProduction ? JSON.stringify(entry) : formatDev(entry);

  switch (level) {
    case "error":
      console.error(output);
      break;
    case "warn":
      console.warn(output);
      break;
    default:
      console.log(output);
  }
}

export const logger = {
  info: (message: string, context?: Record<string, unknown>) => log("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => log("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => log("error", message, context),
};

// Convenience wrapper for catch blocks. Extracts message and stack from Error
// objects so they serialize correctly to JSON in production logs.
//
// It ALSO records the error durably (ErrorEvent, grouped by fingerprint) and
// alerts on new or escalating ones. That is deliberately hung off this
// function rather than introduced as a new API: there are ~491 logError call
// sites already, so the instrumentation was never the missing piece — the
// missing piece was that it wrote to stdout and died with the container on
// every redeploy. Changing the one function makes all 491 durable at once.
//
// `logger.error` stays a plain log with no persistence. Two reasons: the
// recorder itself must be able to complain without re-entering (see
// errorRecorder's recursion rule), and not every error-level line is an
// incident worth a row.
export function logError(message: string, err: unknown, context?: Record<string, unknown>): void {
  logger.error(message, {
    ...context,
    error: err instanceof Error ? err.message : String(err),
    ...(err instanceof Error && err.stack ? { stack: err.stack.split("\n")[0] } : {}),
  });

  // Server only, and imported lazily: the recorder reaches for Prisma, which
  // must never be pulled into a client bundle just because a component
  // imported the logger. Failure to even load it is swallowed -- logging must
  // not be able to break a request.
  if (typeof window !== "undefined") return;
  void import("@/lib/errorRecorder")
    .then(({ recordError }) => recordError({ message, error: err, context }))
    .catch(() => {
      /* stdout above is the fallback; never let recording break the caller */
    });
}
