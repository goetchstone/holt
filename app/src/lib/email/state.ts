// /app/src/lib/email/state.ts
//
// Pure retry state machine for a queued email after a send attempt. Keeps the
// policy testable without nodemailer or a DB.

import type { EmailStatus } from "@prisma/client";

export const MAX_EMAIL_ATTEMPTS = 4;

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
