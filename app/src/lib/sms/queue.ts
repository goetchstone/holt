// /app/src/lib/sms/queue.ts
//
// The durable queue of texts (GAP-12), the same shape as lib/email/queue.ts and
// drained by the same cron, with the same retries (lib/email/state.ts). What is
// different about a text:
//   - a STOP can arrive between queuing and sending, so each send checks again;
//   - a refusal that can't change (a bad number, a STOP) fails at once instead
//     of being retried, since each try is billed or counted against the sender;
//   - a provider's acceptance isn't delivery. SENT is "accepted"; the delivery
//     report sets deliveredAt, or turns the row FAILED (lib/sms/webhook.ts).

import type { EmailStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import {
  INTERRUPTED_SEND_ERROR,
  isClaimedElsewhere,
  MAX_EMAIL_ATTEMPTS,
  nextEmailState,
  SEND_CLAIM_LEASE_MS,
} from "@/lib/email/state";
import { REPLIED_STOP, isSmsOptedOut } from "./consent";
import { getActiveSmsProvider } from "./index";

export interface EnqueueSmsInput {
  to: string;
  body: string;
  templateKey?: string;
  createdBy?: string | null;
  organizationId?: number;
}

export async function enqueueSms(
  input: EnqueueSmsInput,
  db: Pick<Prisma.TransactionClient, "smsQueue"> = prisma,
): Promise<number> {
  const row = await db.smsQueue.create({
    data: {
      organizationId: input.organizationId ?? DEFAULT_ORG_ID,
      toPhone: input.to,
      body: input.body,
      templateKey: input.templateKey ?? null,
      createdBy: input.createdBy ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

/** Twilio can only report back to an address it can reach. */
export function smsWebhookUrl(): string | undefined {
  const base = (process.env.NEXTAUTH_URL ?? "").replace(/\/+$/, "");
  return base.startsWith("https://") ? `${base}/api/sms/twilio/webhook` : undefined;
}

type QueuedSms = {
  id: number;
  toPhone: string;
  body: string;
  attempts: number;
  scheduledAt: Date;
};

/**
 * Take a row for this drain alone before sending it: the same compare-and-set
 * lease as lib/email/queue.ts, for the same reason. Each text is billed, and two
 * drains (the cron and a screen's send-now, or two app processes) each sent it.
 */
async function claimRow(row: QueuedSms): Promise<boolean> {
  const claimed = await prisma.smsQueue.updateMany({
    where: {
      id: row.id,
      status: "PENDING",
      attempts: row.attempts,
      scheduledAt: row.scheduledAt,
    },
    data: {
      attempts: row.attempts + 1,
      scheduledAt: new Date(Date.now() + SEND_CLAIM_LEASE_MS),
    },
  });
  return claimed.count === 1;
}

/**
 * Claim one row, send it and record what happened. "taken" when another drain
 * has it; null when no provider is set up (the row is handed back, still PENDING).
 */
async function deliverRow(row: QueuedSms): Promise<{ status: EmailStatus } | "taken" | null> {
  if (!(await claimRow(row))) return "taken";
  if (await isSmsOptedOut(prisma, row.toPhone)) {
    await prisma.smsQueue.update({
      where: { id: row.id },
      // Not a try: nothing went to the provider.
      data: {
        status: "FAILED",
        lastError: REPLIED_STOP,
        attempts: row.attempts,
        scheduledAt: row.scheduledAt,
      },
    });
    return { status: "FAILED" };
  }
  const result = await getActiveSmsProvider().send({
    to: row.toPhone,
    body: row.body,
    statusCallbackUrl: smsWebhookUrl(),
  });
  if (result.outcome === "not-configured") {
    await prisma.smsQueue.update({
      where: { id: row.id },
      data: { attempts: row.attempts, scheduledAt: row.scheduledAt },
    });
    return null;
  }
  if (result.outcome === "refused" && result.recipientOptedOut) {
    await prisma.smsOptOut.upsert({
      where: { phone: row.toPhone },
      create: { phone: row.toPhone, source: "PROVIDER" },
      update: {},
    });
  }
  const accepted = result.outcome === "accepted";
  const state = nextEmailState(row.attempts, accepted, new Date(), accepted ? null : result.error);
  const status: EmailStatus = !accepted && result.permanent ? "FAILED" : state.status;
  await prisma.smsQueue.update({
    where: { id: row.id },
    data: {
      status,
      attempts: state.attempts,
      sentAt: state.sentAt,
      lastError: state.lastError,
      providerMessageId: accepted ? result.providerMessageId : null,
      // Back from the lease to when it was due, so a failed send is retried.
      scheduledAt: row.scheduledAt,
    },
  });
  return { status };
}

const QUEUED_SELECT = {
  id: true,
  toPhone: true,
  body: true,
  attempts: true,
  scheduledAt: true,
} as const;

/**
 * Try one queued text now, for a screen that tells staff whether it went.
 * PENDING when another drain is sending it at this moment.
 */
export async function deliverQueuedSms(id: number): Promise<EmailStatus> {
  const row = await prisma.smsQueue.findUniqueOrThrow({
    where: { id },
    select: { ...QUEUED_SELECT, status: true },
  });
  if (row.status !== "PENDING") return row.status;
  if (isClaimedElsewhere(row.scheduledAt, new Date())) return "PENDING";
  const outcome = await deliverRow(row);
  if (outcome === "taken") {
    const now = await prisma.smsQueue.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    });
    return now.status;
  }
  return outcome?.status ?? "PENDING";
}

export interface SmsProcessSummary {
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
}

export async function processSmsQueue(
  organizationId: number = DEFAULT_ORG_ID,
  limit = 25,
): Promise<SmsProcessSummary> {
  const now = new Date();
  // A text claimed for its last try whose process stopped before writing the
  // outcome: the same sweep, for the same reason, as lib/email/queue.ts's
  // failInterruptedLastTries.
  await prisma.smsQueue.updateMany({
    where: {
      organizationId,
      status: "PENDING",
      attempts: { gte: MAX_EMAIL_ATTEMPTS },
      scheduledAt: { lte: now },
    },
    data: { status: "FAILED", lastError: INTERRUPTED_SEND_ERROR },
  });
  const due = await prisma.smsQueue.findMany({
    where: {
      organizationId,
      status: "PENDING",
      scheduledAt: { lte: now },
      attempts: { lt: MAX_EMAIL_ATTEMPTS },
    },
    orderBy: { scheduledAt: "asc" },
    take: limit,
    select: QUEUED_SELECT,
  });
  const summary: SmsProcessSummary = { processed: 0, sent: 0, failed: 0, skipped: 0 };
  for (const row of due) {
    const outcome = await deliverRow(row);
    // Another drain is sending this one; it counts it, not us.
    if (outcome === "taken") continue;
    // No provider set up: nothing will send this run, and the rows wait for one.
    if (!outcome) {
      summary.skipped++;
      break;
    }
    summary.processed++;
    if (outcome.status === "SENT") summary.sent++;
    else if (outcome.status === "FAILED") summary.failed++;
  }
  return summary;
}
