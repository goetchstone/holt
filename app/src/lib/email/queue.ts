// /app/src/lib/email/queue.ts
//
// Enqueue + process the durable email queue. enqueueEmail records a PENDING row;
// processEmailQueue sends due rows via the sender and advances each row's state
// (lib/email/state.ts). Safe to call fire-and-forget right after a write (prompt
// delivery) or from a cron to drain retries. Server-only (imports the sender).

import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import type { EmailStatus } from "@prisma/client";
import { sendEmail, type EmailAttachment } from "./sender";
import { nextEmailState, MAX_EMAIL_ATTEMPTS } from "./state";

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

export async function enqueueEmail(input: EnqueueInput): Promise<number> {
  const row = await prisma.emailQueue.create({
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
  attachments: { filename: string; contentType: string; content: Uint8Array }[];
};

/** Send one row and record what happened. Null when SMTP isn't set up (the row stays PENDING). */
async function deliverRow(
  row: QueuedRow,
  organizationId: number,
): Promise<{ status: EmailStatus } | null> {
  const result = await sendEmail(
    {
      to: row.toAddress,
      subject: row.subject,
      html: row.html,
      attachments: row.attachments.map((a) => ({ ...a, content: Buffer.from(a.content) })),
    },
    organizationId,
  );
  if (result.skipped) return null;
  const state = nextEmailState(row.attempts, result.ok, new Date(), result.error);
  await prisma.emailQueue.update({
    where: { id: row.id },
    data: {
      status: state.status,
      attempts: state.attempts,
      sentAt: state.sentAt,
      lastError: state.lastError,
    },
  });
  return { status: state.status };
}

/**
 * Try one queued email now, for a screen that tells the sender whether it went.
 * PENDING after a failed try means it stays queued for the next drain.
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
      status: true,
      ...WITH_ATTACHMENTS,
    },
  });
  if (row.status !== "PENDING") return row.status;
  return (await deliverRow(row, organizationId))?.status ?? "PENDING";
}

export interface ProcessSummary {
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
}

export async function processEmailQueue(
  organizationId: number = DEFAULT_ORG_ID,
  limit = 25,
): Promise<ProcessSummary> {
  const now = new Date();
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
