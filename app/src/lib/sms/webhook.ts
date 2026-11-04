// /app/src/lib/sms/webhook.ts
//
// What a genuine provider webhook changes (GAP-12): a number's STOP or START, and
// whether a text reached the phone. The route verifies the signature first.

import { prisma } from "@/lib/prisma";
import type { SmsWebhookEvent } from "./types";

export async function applySmsWebhookEvent(event: SmsWebhookEvent): Promise<void> {
  switch (event.kind) {
    case "opt-out":
      await prisma.smsOptOut.upsert({
        where: { phone: event.phone },
        create: { phone: event.phone, source: "REPLY" },
        update: {},
      });
      return;
    case "opt-in":
      await prisma.smsOptOut.deleteMany({ where: { phone: event.phone } });
      return;
    case "delivered":
      await prisma.smsQueue.updateMany({
        where: { providerMessageId: event.providerMessageId },
        data: { deliveredAt: new Date() },
      });
      return;
    case "undelivered":
      await prisma.smsQueue.updateMany({
        where: { providerMessageId: event.providerMessageId },
        data: { status: "FAILED", lastError: event.error, deliveredAt: null },
      });
      return;
    case "other":
      return;
  }
}
