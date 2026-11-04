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
import { MAX_EMAIL_ATTEMPTS, nextEmailState } from "@/lib/email/state";
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

type QueuedSms = { id: number; toPhone: string; body: string; attempts: number };

/** Send one row and record what happened. Null when no provider is set up (the row stays PENDING). */
async function deliverRow(row: QueuedSms): Promise<{ status: EmailStatus } | null> {
  if (await isSmsOptedOut(prisma, row.toPhone)) {
    await prisma.smsQueue.update({
      where: { id: row.id },
      data: { status: "FAILED", lastError: REPLIED_STOP },
    });
    return { status: "FAILED" };
  }
  const result = await getActiveSmsProvider().send({
    to: row.toPhone,
    body: row.body,
    statusCallbackUrl: smsWebhookUrl(),
  });
  if (result.outcome === "not-configured") return null;
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
    },
  });
  return { status };
}

const QUEUED_SELECT = { id: true, toPhone: true, body: true, attempts: true } as const;

/** Try one queued text now, for a screen that tells staff whether it went. */
export async function deliverQueuedSms(id: number): Promise<EmailStatus> {
  const row = await prisma.smsQueue.findUniqueOrThrow({
    where: { id },
    select: { ...QUEUED_SELECT, status: true },
  });
  if (row.status !== "PENDING") return row.status;
  return (await deliverRow(row))?.status ?? "PENDING";
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
  const due = await prisma.smsQueue.findMany({
    where: {
      organizationId,
      status: "PENDING",
      scheduledAt: { lte: new Date() },
      attempts: { lt: MAX_EMAIL_ATTEMPTS },
    },
    orderBy: { scheduledAt: "asc" },
    take: limit,
    select: QUEUED_SELECT,
  });
  const summary: SmsProcessSummary = { processed: 0, sent: 0, failed: 0, skipped: 0 };
  for (const row of due) {
    const outcome = await deliverRow(row);
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
