// /app/src/lib/messages/history.ts
//
// GAP-13: an order's automatic customer messages for its order page: what
// went, what didn't and why, and where each email stands in the queue. Not
// why an email failed: that is the mail server's answer, which Admin › Email
// shows to whoever runs the integrations.

import { prisma } from "@/lib/prisma";
import { MESSAGE_CATALOG, isMessageKind } from "./catalog";

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
  return messages.map((m) => {
    const email = m.emailQueueId == null ? undefined : emails.get(m.emailQueueId);
    return {
      id: m.id,
      kind: m.kind,
      label: isMessageKind(m.kind) ? MESSAGE_CATALOG[m.kind].label : m.kind,
      created: m.created.toISOString(),
      status: m.status,
      skipReason: m.skipReason,
      toAddress: m.toAddress,
      emailStatus: email?.status ?? null,
      sentAt: email?.sentAt?.toISOString() ?? null,
    };
  });
}
