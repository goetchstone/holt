// /app/src/lib/email/queue.ts
//
// Enqueue + process the durable email queue. enqueueEmail records a PENDING row;
// processEmailQueue sends due rows via the sender and advances each row's state
// (lib/email/state.ts). Safe to call fire-and-forget right after a write (prompt
// delivery) or from a cron to drain retries. Server-only (imports the sender).

import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import { sendEmail } from "./sender";
import { nextEmailState, MAX_EMAIL_ATTEMPTS } from "./state";

export interface EnqueueInput {
  organizationId?: number;
  to: string;
  subject: string;
  html: string;
  templateKey?: string;
  createdBy?: string | null;
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
    },
    select: { id: true },
  });
  return row.id;
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
  });

  const summary: ProcessSummary = { processed: 0, sent: 0, failed: 0, skipped: 0 };
  for (const row of due) {
    const result = await sendEmail(
      { to: row.toAddress, subject: row.subject, html: row.html },
      organizationId,
    );
    // SMTP not configured -- leave everything PENDING and stop; nothing will
    // send this run, and the rows are picked up once SMTP is set.
    if (result.skipped) {
      summary.skipped++;
      break;
    }
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
    summary.processed++;
    if (state.status === "SENT") summary.sent++;
    else if (state.status === "FAILED") summary.failed++;
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
