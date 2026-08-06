// /app/src/lib/errorRecorder.ts
//
// Turns a logError() call into a durable, grouped ErrorEvent row and — for
// errors worth waking someone for — an ops alert. Server-only: it touches
// Prisma, so logger.ts imports it lazily and only when running on the server.
//
// This exists because holt had 491 logError call sites and none of them
// survived a redeploy. The instrumentation was already everywhere; it just
// wrote to stdout and vanished. Changing this one path makes all 491 durable.
//
// THREE RULES, in priority order. Each is a way error handling normally makes
// an outage worse rather than better:
//
//   1. NEVER THROW, never reject. An exception raised while recording an
//      exception turns a handled 500 into an unhandled crash, and it happens
//      exactly when the system is already unhealthy (the database being down
//      is precisely when errors spike). Every path here is wrapped, and the
//      fallback is always "log to stdout and move on".
//
//   2. NEVER BLOCK the response. 491 call sites cannot each await a database
//      round trip. Recording is fire-and-forget; the caller's promise is never
//      tied to it.
//
//   3. NEVER RECURSE. If writing the row fails, that failure must not be
//      recorded through the same path — that is an infinite loop that writes
//      until the disk fills. The recursion guard below is not defensive
//      programming, it is load-bearing.

import { fingerprintError } from "@/lib/errorFingerprint";
import { reportOpsAlert } from "@/lib/opsAlert";

/** Set while recording, so a failure inside recording cannot re-enter. */
let recording = false;

/**
 * Alert thresholds. A NEW fingerprint alerts immediately (you want to know
 * about a bug the first time it happens). After that, alerting is
 * exponential-ish rather than per-occurrence: a crash loop should send a
 * handful of alerts, not one per request. Without this, the first real
 * incident buries the on-call in 5,000 emails and the channel gets muted —
 * which is worse than never having alerted at all.
 */
const ALERT_AT_COUNTS = new Set([1, 10, 100, 1000, 10000]);

/** Truncate anything before it goes in a column or an alert body. */
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export interface RecordErrorInput {
  message: string;
  error?: unknown;
  context?: Record<string, unknown>;
}

/**
 * Persist and possibly alert. Returns immediately; the work happens on a
 * detached promise whose rejection is swallowed.
 */
export function recordError(input: RecordErrorInput): void {
  // No database configured means nowhere to record to. This is the honest
  // condition, and it also covers the contexts where scheduling detached work
  // is actively harmful: unit tests (no DB) would otherwise have this
  // promise outlive the test and Jest would fail the run with "Cannot log
  // after tests are done", and build-time or CLI code would keep the process
  // alive waiting on a connection that will never open.
  if (!process.env.DATABASE_URL) return;

  // Guard BEFORE the async boundary so a synchronous throw during setup
  // cannot re-enter either.
  if (recording) return;

  void (async () => {
    recording = true;
    try {
      await persist(input);
    } catch (err) {
      // Deliberately console, not logError: routing this back through the
      // logger is the recursion rule 3 forbids.
      // eslint-disable-next-line no-console
      console.error(
        "[errorRecorder] failed to record an error (the original error is above):",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      recording = false;
    }
  })();
}

async function persist({ message, error, context }: RecordErrorInput): Promise<void> {
  // Imported here rather than at module scope so merely importing the logger
  // never pulls Prisma into a bundle that does not need it.
  const { prisma } = await import("@/lib/prisma");

  const err = error instanceof Error ? error : undefined;
  // The message an operator reads should include the thrown error's own text,
  // not just the call site's label ("Failed to save order" tells you nothing
  // without "unique constraint violated on Order.orderno").
  const full = err ? `${message}: ${err.message}` : message;
  const { fingerprint, normalized, stackTop } = fingerprintError(full, err?.stack);

  const sample = {
    ...(context ?? {}),
    ...(err?.name ? { errorName: err.name } : {}),
  };

  // Upsert is the whole grouping strategy: one row per fingerprint, count
  // incremented. `resolvedAt: null` on update is intentional — a recurrence
  // un-resolves an acknowledged error, because "I looked at this" should not
  // permanently silence a bug that came back.
  const row = await prisma.errorEvent.upsert({
    where: { fingerprint },
    create: {
      fingerprint,
      message: clip(full, 2000),
      normalized: clip(normalized, 2000),
      stackTop: stackTop ? clip(stackTop, 500) : null,
      sample,
    },
    update: {
      count: { increment: 1 },
      lastSeenAt: new Date(),
      message: clip(full, 2000),
      stackTop: stackTop ? clip(stackTop, 500) : null,
      sample,
      resolvedAt: null,
      resolvedBy: null,
    },
    select: { count: true, fingerprint: true },
  });

  if (!ALERT_AT_COUNTS.has(row.count)) return;

  await reportOpsAlert({
    title:
      row.count === 1
        ? `New error: ${clip(normalized, 120)}`
        : `Error seen ${row.count}x: ${clip(normalized, 120)}`,
    detail: [full, stackTop ? `at ${stackTop}` : null].filter(Boolean).join("\n"),
    context: { ...sample, occurrences: row.count, fingerprint: row.fingerprint },
  });
}
