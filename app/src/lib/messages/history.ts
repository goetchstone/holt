// /app/src/lib/messages/history.ts
//
// GAP-13: an order's automatic customer messages for its order page: what
// went, what didn't and why, and where each email stands in the queue. Not
// why an email failed: that is the mail server's answer, which Admin › Email
// shows to whoever runs the integrations.

import { prisma } from "@/lib/prisma";
import { MESSAGE_CATALOG, ORDER_LINK_KIND, ORDER_LINK_LABEL, isMessageKind } from "./catalog";

export interface OrderMessage {
  id: number;
  kind: string;
  label: string;
  created: string;
  /** QUEUED or SKIPPED, as recorded. */
  status: string;
  skipReason: string | null;
  toAddress: string | null;
  /** The email's state in the queue: PENDING, SENT or FAILED; null when skipped. */
  emailStatus: string | null;
  sentAt: string | null;
  /** The text, when the message took that channel (GAP-12). */
  text: {
    toPhone: string | null;
    /** PENDING, SENT (the provider accepted it) or FAILED; null when skipped. */
    status: string | null;
    sentAt: string | null;
    /** The carrier said it arrived. */
    deliveredAt: string | null;
    skipReason: string | null;
  } | null;
}

function labelOf(kind: string): string {
  if (kind === ORDER_LINK_KIND) return ORDER_LINK_LABEL;
  return isMessageKind(kind) ? MESSAGE_CATALOG[kind].label : kind;
}

export async function orderMessages(salesOrderId: number): Promise<OrderMessage[]> {
  const messages = await prisma.customerMessage.findMany({
    where: { salesOrderId },
    orderBy: { id: "desc" },
  });
  const ids = messages.flatMap((m) => (m.emailQueueId == null ? [] : [m.emailQueueId]));
  const emails = new Map(
    (
      await prisma.emailQueue.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true, sentAt: true },
      })
    ).map((e) => [e.id, e]),
  );
  const smsIds = messages.flatMap((m) => (m.smsQueueId == null ? [] : [m.smsQueueId]));
  const texts = new Map(
    (
      await prisma.smsQueue.findMany({
        where: { id: { in: smsIds } },
        select: { id: true, status: true, sentAt: true, deliveredAt: true },
      })
    ).map((t) => [t.id, t]),
  );
  return messages.map((m) => {
    const email = m.emailQueueId == null ? undefined : emails.get(m.emailQueueId);
    const text = m.smsQueueId == null ? undefined : texts.get(m.smsQueueId);
    return {
      id: m.id,
      kind: m.kind,
      label: labelOf(m.kind),
      created: m.created.toISOString(),
      status: m.status,
      skipReason: m.skipReason,
      toAddress: m.toAddress,
      emailStatus: email?.status ?? null,
      sentAt: email?.sentAt?.toISOString() ?? null,
      text:
        m.toPhone || m.smsSkipReason
          ? {
              toPhone: m.toPhone,
              status: text?.status ?? null,
              sentAt: text?.sentAt?.toISOString() ?? null,
              deliveredAt: text?.deliveredAt?.toISOString() ?? null,
              skipReason: m.smsSkipReason,
            }
          : null,
    };
  });
}
