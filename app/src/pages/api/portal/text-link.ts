// /app/src/pages/api/portal/text-link.ts
//
// POST { orderId } -- text the customer the link to their order, from the order
// page (GAP-12). Staff chose to send it, so a customer's "No automatic messages"
// doesn't stop it, but the rules on who may get a text do (lib/sms/consent.ts).
// Staff are told whether it went, like the PO email: enqueue, then try it now.
// A failure stays on the queue, and Admin › Email has the provider's reason.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/appSettings";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { ORDER_LINK_KIND, ORDER_LINK_TEXT } from "@/lib/messages/catalog";
import { customerName, renderTextMessage } from "@/lib/messages/render";
import { portalOrderUrl } from "@/lib/portalLink";
import { isSmsConfigured } from "@/lib/sms";
import { textableNumber } from "@/lib/sms/consent";
import { deliverQueuedSms, enqueueSms } from "@/lib/sms/queue";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const orderId = (req.body as { orderId?: unknown } | undefined)?.orderId;
  if (typeof orderId !== "number") return res.status(400).json({ error: "Which order?" });
  try {
    const order = await prisma.salesOrder.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderno: true,
        customer: {
          select: { id: true, firstName: true, lastName: true, phone: true, smsConsentAt: true },
        },
      },
    });
    if (!order) return res.status(404).json({ error: "Order not found." });
    const customer = order.customer;
    if (!customer) return res.status(400).json({ error: "This order has no customer." });
    if (!(await isSmsConfigured())) {
      return res
        .status(409)
        .json({ error: "Texting isn't set up. An administrator can in Settings › Integrations." });
    }
    const app = await getAppSettings();
    const number = await textableNumber(prisma, customer, app.locale);
    if ("problem" in number) return res.status(409).json({ error: number.problem });

    const body = renderTextMessage({
      body: ORDER_LINK_TEXT,
      values: {
        customer: customerName(customer),
        order: order.orderno,
        store: app.companyName?.trim() || app.appName,
      },
      orderUrl: portalOrderUrl(order.id, customer.id, app.portalTokenTtlHours),
      reviewUrl: null,
    });
    const actor = session.user?.email ?? null;
    const smsQueueId = await prisma.$transaction(async (tx) => {
      const id = await enqueueSms(
        { to: number.phone, body, templateKey: "order-link", createdBy: actor },
        tx,
      );
      await tx.customerMessage.create({
        data: {
          kind: ORDER_LINK_KIND,
          dedupeKey: `${ORDER_LINK_KIND}:${id}`,
          salesOrderId: order.id,
          customerId: customer.id,
          status: "QUEUED",
          toPhone: number.phone,
          smsQueueId: id,
        },
      });
      return id;
    });
    const status = await deliverQueuedSms(smsQueueId);
    if (status === "FAILED") {
      return res
        .status(502)
        .json({ error: "The text couldn't be sent. Admin › Email has the reason.", status });
    }
    return res.status(200).json({ status, to: number.phone });
  } catch (err) {
    logError("Texting an order link failed", err, { orderId });
    return res.status(500).json({ error: "Failed to text the link" });
  }
}

export default requirePermission("sales.write", handler);
