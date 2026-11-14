// /app/src/lib/email/state.ts
//
// Pure retry state machine for a queued email after a send attempt. Keeps the
// policy testable without nodemailer or a DB.

import type { EmailStatus } from "@prisma/client";

export const MAX_EMAIL_ATTEMPTS = 4;

/**
 * How long a claimed row stays out of every other drain's reach while it is
 * being sent (lib/email/queue.ts, lib/sms/queue.ts). Longer than a send can
 * take -- nodemailer's socket timeout is ten minutes -- so a slow send is not
 * claimed and sent a second time.
 *
 * The claim counts the try, so a process that dies mid-send (a deploy, a
 * crash, a database error before the outcome is written) has used one. Once
 * the lease runs out the row is retried by the next drain -- or, when that was
 * its last try, marked FAILED with INTERRUPTED_SEND_ERROR by the next drain
 * (failInterruptedLastTries), since no drain would ever pick it up again.
 */
export const SEND_CLAIM_LEASE_MS = 15 * 60_000;

/**
 * Why a row is FAILED when its last try was claimed and never finished. It may
 * or may not have reached the recipient: the process stopped before it could
 * record which.
 */
export const INTERRUPTED_SEND_ERROR =
  "The last try was interrupted before its result was recorded; it may or may not have been sent.";

/**
 * True when a row's scheduledAt is a claim's lease rather than a time it is due:
 * further in the future than any clock difference between an app process and
 * the database. Pure.
 */
export function isClaimedElsewhere(scheduledAt: Date, now: Date): boolean {
  return scheduledAt.getTime() - now.getTime() > 60_000;
}

export interface EmailSendOutcome {
  status: EmailStatus;
  attempts: number;
  sentAt: Date | null;
  lastError: string | null;
}

// Given the prior attempt count and whether this send succeeded, return the new
// persisted state. On failure it stays PENDING (to retry) until attempts reach
// MAX_EMAIL_ATTEMPTS, then it's FAILED.
export function nextEmailState(
  priorAttempts: number,
  ok: boolean,
  now: Date,
  error?: string | null,
): EmailSendOutcome {
  const attempts = priorAttempts + 1;
  if (ok) {
    return { status: "SENT", attempts, sentAt: now, lastError: null };
  }
  const exhausted = attempts >= MAX_EMAIL_ATTEMPTS;
  return {
    status: exhausted ? "FAILED" : "PENDING",
    attempts,
    sentAt: null,
    lastError: error ?? "send failed",
  };
}
