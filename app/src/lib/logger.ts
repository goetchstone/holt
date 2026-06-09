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
export function logError(message: string, err: unknown, context?: Record<string, unknown>): void {
  logger.error(message, {
    ...context,
    error: err instanceof Error ? err.message : String(err),
    ...(err instanceof Error && err.stack ? { stack: err.stack.split("\n")[0] } : {}),
  });
}
