// /app/src/pages/api/purchasing/orders/[id]/email.ts
//
// GAP-01: POST { to, message? } -- email the purchase order to its vendor with
// its PDF attached (lib/purchasing/purchaseOrderDocument.ts, the same PDF the
// screen prints). The email goes through the queue (lib/email/queue.ts) and is
// tried at once, so the sender learns whether it went; one that fails stays
// queued and is retried. A draft that is sent becomes Submitted.
//
// Refused when email isn't set up, rather than queued where nobody can see it
// waiting. "Write purchase orders"; prices only for a holder of "View cost".

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requirePermission, type CallerAccess } from "@/lib/auth/requireAuth";
import { canViewCost, WITH_COST } from "@/lib/auth/costVisibility";
import { logError } from "@/lib/logger";
import { isEmailConfigured } from "@/lib/email/config";
import { deliverQueuedEmail, enqueueEmail } from "@/lib/email/queue";
import { purchaseOrderEmail } from "@/lib/email/templates";
import { purchaseOrderDocument } from "@/lib/purchasing/purchaseOrderDocument";
import { PurchaseOrderError } from "@/lib/purchasing/stockPurchaseOrder";

const Body = z.object({
  to: z.email("Enter the vendor's email address.").max(254),
  message: z.string().max(2000, "The message can be at most 2000 characters.").nullish(),
});

/** Exported for integration tests. */
export async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess,
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  const poId = Number.parseInt(String(req.query.id), 10);
  if (Number.isNaN(poId)) return res.status(400).json({ error: "Invalid purchase order ID." });
  const body = Body.safeParse({ ...(req.body ?? {}), to: String(req.body?.to ?? "").trim() });
  if (!body.success) return res.status(400).json({ error: body.error.issues[0].message });

  try {
    if (!(await isEmailConfigured())) {
      return res.status(409).json({
        error: "Email isn't set up yet. An admin sets it up in Settings → Integrations.",
      });
    }
    const doc = await purchaseOrderDocument(poId, canViewCost(access));
    if (doc.status === "CANCELLED") {
      return res.status(409).json({ error: "A cancelled purchase order can't be sent." });
    }
    const actor = session.user?.email ?? null;
    const email = purchaseOrderEmail({
      companyName: doc.companyName,
      vendorName: doc.vendorName,
      poNumber: doc.poNumber,
      message: body.data.message,
    });
    const queued = await enqueueEmail({
      to: body.data.to,
      subject: email.subject,
      html: email.html,
      templateKey: "purchase-order",
      createdBy: actor,
      attachments: [{ filename: doc.filename, contentType: "application/pdf", content: doc.pdf }],
    });
    if ((await deliverQueuedEmail(queued)) !== "SENT") {
      return res.status(502).json({
        error: "The email couldn't be sent just now. It stays queued and will be tried again.",
      });
    }
    // Sending a draft is submitting it; a PO already further along keeps its status.
    await prisma.purchaseOrder.updateMany({
      where: { id: poId, status: "DRAFT" },
      data: { status: "SUBMITTED", updatedBy: actor },
    });
    return res.status(200).json({ sent: true, to: body.data.to });
  } catch (err) {
    if (err instanceof PurchaseOrderError) {
      return res.status(err.status).json({ error: err.message });
    }
    logError("Error emailing purchase order", err);
    return res.status(500).json({ error: "Failed to email the purchase order." });
  }
}

export default requirePermission("purchasing.write", handler, WITH_COST);
