// /app/src/lib/email/queue.ts
//
// Enqueue + process the durable email queue. enqueueEmail records a PENDING row;
// processEmailQueue sends due rows via the sender and advances each row's state
// (lib/email/state.ts). Safe to call fire-and-forget right after a write (prompt
// delivery) or from a cron to drain retries, from any number of app processes:
// each row is claimed before it is sent, so two drains never send one row twice
// (claimRow below). Server-only (imports the sender).

import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import type { EmailStatus, Prisma } from "@prisma/client";
import { sendEmail, type EmailAttachment } from "./sender";
import {
  INTERRUPTED_SEND_ERROR,
  isClaimedElsewhere,
  nextEmailState,
  MAX_EMAIL_ATTEMPTS,
  SEND_CLAIM_LEASE_MS,
} from "./state";

export interface EnqueueInput {
  organizationId?: number;
  to: string;
  subject: string;
  html: string;
  templateKey?: string;
  createdBy?: string | null;
  /** Kept on the queue row, so a retry sends the same files. */
  attachments?: readonly EmailAttachment[];
}

/**
 * Record a PENDING email. Pass a transaction as `db` to queue it with the
 * caller's own write, so the two are kept or lost together.
 */
export async function enqueueEmail(
  input: EnqueueInput,
  db: Pick<Prisma.TransactionClient, "emailQueue"> = prisma,
): Promise<number> {
  const row = await db.emailQueue.create({
    data: {
      organizationId: input.organizationId ?? DEFAULT_ORG_ID,
      toAddress: input.to,
      subject: input.subject,
      html: input.html,
      templateKey: input.templateKey ?? null,
      createdBy: input.createdBy ?? null,
      ...(input.attachments?.length
        ? {
            attachments: {
              create: input.attachments.map((a) => ({
                filename: a.filename,
                contentType: a.contentType,
                content: new Uint8Array(a.content),
              })),
            },
          }
        : {}),
    },
    select: { id: true },
  });
  return row.id;
}

const WITH_ATTACHMENTS = {
  attachments: { select: { filename: true, contentType: true, content: true } },
} as const;

type QueuedRow = {
  id: number;
  toAddress: string;
  subject: string;
  html: string;
  attempts: number;
  scheduledAt: Date;
  attachments: { filename: string; contentType: string; content: Uint8Array }[];
};

/**
 * Take a row for this drain alone, before sending it. Two drains can hold the
 * same PENDING row -- the cron and the send right after a write, or two app
 * processes -- and without this both sent it. A compare-and-set on what this
 * drain read (the same shape as the automations runner's claim): it wins only
 * if nobody changed the row since, and it pushes scheduledAt out by the lease
 * so no other drain picks the row up while it is being sent. False when another
 * drain got there first.
 */
async function claimRow(row: QueuedRow): Promise<boolean> {
  const claimed = await prisma.emailQueue.updateMany({
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

/** Hand a claimed row back untouched, for when nothing was sent. */
async function releaseRow(row: QueuedRow): Promise<void> {
  await prisma.emailQueue.update({
    where: { id: row.id },
    data: { attempts: row.attempts, scheduledAt: row.scheduledAt },
  });
}

/**
 * Claim one row, send it and record what happened. "taken" when another drain
 * has it; null when SMTP isn't set up (the row is handed back, still PENDING).
 */
async function deliverRow(
  row: QueuedRow,
  organizationId: number,
): Promise<{ status: EmailStatus } | "taken" | null> {
  if (!(await claimRow(row))) return "taken";
  const result = await sendEmail(
    {
      to: row.toAddress,
      subject: row.subject,
      html: row.html,
      attachments: row.attachments.map((a) => ({ ...a, content: Buffer.from(a.content) })),
    },
    organizationId,
  );
  if (result.skipped) {
    await releaseRow(row);
    return null;
  }
  const state = nextEmailState(row.attempts, result.ok, new Date(), result.error);
  await prisma.emailQueue.update({
    where: { id: row.id },
    data: {
      status: state.status,
      attempts: state.attempts,
      sentAt: state.sentAt,
      lastError: state.lastError,
      // Back from the lease to when it was due, so a failed send is retried by
      // the next drain, as before claims existed.
      scheduledAt: row.scheduledAt,
    },
  });
  return { status: state.status };
}

/**
 * Try one queued email now, for a screen that tells the sender whether it went.
 * PENDING after a failed try means it stays queued for the next drain; PENDING
 * also when another drain is sending it at this moment.
 */
export async function deliverQueuedEmail(
  id: number,
  organizationId: number = DEFAULT_ORG_ID,
): Promise<EmailStatus> {
  const row = await prisma.emailQueue.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      toAddress: true,
      subject: true,
      html: true,
      attempts: true,
      scheduledAt: true,
      status: true,
      ...WITH_ATTACHMENTS,
    },
  });
  if (row.status !== "PENDING") return row.status;
  if (isClaimedElsewhere(row.scheduledAt, new Date())) return "PENDING";
  const outcome = await deliverRow(row, organizationId);
  if (outcome === "taken") {
    // Another drain claimed it between the read and the claim; report where it is.
    const now = await prisma.emailQueue.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    });
    return now.status;
  }
  return outcome?.status ?? "PENDING";
}

export interface ProcessSummary {
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
}

/**
 * Rows claimed for their last try whose process stopped before writing what
 * happened: PENDING with every try used, and the claim's lease run out. No
 * drain selects them again (attempts < MAX_EMAIL_ATTEMPTS below), so without
 * this they stayed PENDING for ever and never showed as failed. Only a row at
 * the cap whose lease has expired matches: a send still under way holds a lease
 * in the future, and an ordinary last failure is written FAILED by deliverRow.
 */
async function failInterruptedLastTries(organizationId: number, now: Date): Promise<void> {
  await prisma.emailQueue.updateMany({
    where: {
      organizationId,
      status: "PENDING",
      attempts: { gte: MAX_EMAIL_ATTEMPTS },
      scheduledAt: { lte: now },
    },
    data: { status: "FAILED", lastError: INTERRUPTED_SEND_ERROR },
  });
}

export async function processEmailQueue(
  organizationId: number = DEFAULT_ORG_ID,
  limit = 25,
): Promise<ProcessSummary> {
  const now = new Date();
  await failInterruptedLastTries(organizationId, now);
  const due = await prisma.emailQueue.findMany({
    where: {
      organizationId,
      status: "PENDING",
      scheduledAt: { lte: now },
      attempts: { lt: MAX_EMAIL_ATTEMPTS },
    },
    orderBy: { scheduledAt: "asc" },
    take: limit,
    include: WITH_ATTACHMENTS,
  });

  const summary: ProcessSummary = { processed: 0, sent: 0, failed: 0, skipped: 0 };
  for (const row of due) {
    const outcome = await deliverRow(row, organizationId);
    // Another drain is sending this one; it counts it, not us.
    if (outcome === "taken") continue;
    // SMTP not configured -- leave everything PENDING and stop; nothing will
    // send this run, and the rows are picked up once SMTP is set.
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

// Enqueue + immediately attempt delivery without blocking the caller's response.
// Errors are swallowed (the row stays PENDING for the next drain).
export function enqueueAndSend(input: EnqueueInput): void {
  const orgId = input.organizationId ?? DEFAULT_ORG_ID;
  void enqueueEmail(input)
    .then(() => processEmailQueue(orgId))
    .catch(() => {
      /* best-effort; durable row remains for the cron */
    });
}
