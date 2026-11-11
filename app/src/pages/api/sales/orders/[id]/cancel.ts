// /app/src/pages/api/sales/orders/[id]/cancel.ts
//
// The one way to cancel a sale (lib/sales/cancelOrder.ts, DECISIONS 51). GET says what's
// on it to settle, for the screen. POST { reason, destination, poDecisions } settles it
// and cancels. Cancelling is sales.cancel. Giving money back takes payment.refund as
// well, the same key as the refund route, so a role that may not refund can't do it this
// way. Committing the store to goods the vendor has acknowledged takes its own key.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission, type CallerAccess } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { RefundError, RefundProcessorError } from "@/lib/paymentService";
import { isRefundDestination } from "@/lib/returns/refundReturn";
import {
  cancelOrder,
  CancelOrderError,
  needsPoCall,
  readCancelPlan,
} from "@/lib/sales/cancelOrder";
import { isPoDecision, type PoDecision } from "@/lib/sales/salePosShared";

const REFUNDS = "payment.refund";
const PO_CALL = "sales.cancel-acknowledged";

function readDecisions(raw: unknown): Record<number, PoDecision> | null {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null) return null;
  const decisions: Record<number, PoDecision> = {};
  for (const [id, decision] of Object.entries(raw)) {
    if (!isPoDecision(decision)) return null;
    decisions[Number(id)] = decision;
  }
  return decisions;
}

async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess,
) {
  const orderId = Number.parseInt(String(req.query.id), 10);
  if (!Number.isInteger(orderId)) return res.status(400).json({ error: "Invalid order." });

  try {
    if (req.method === "GET") {
      const plan = await readCancelPlan(orderId);
      return res
        .status(200)
        .json({ ...plan, canRefund: access.holds[REFUNDS], canCallPo: access.holds[PO_CALL] });
    }
    if (req.method === "POST") {
      const body = (req.body ?? {}) as {
        reason?: unknown;
        destination?: unknown;
        poDecisions?: unknown;
      };
      if (body.destination !== undefined && !isRefundDestination(body.destination)) {
        return res
          .status(400)
          .json({ error: "destination must be ORIGINAL_PAYMENT or STORE_CREDIT." });
      }
      const poDecisions = readDecisions(body.poDecisions);
      if (!poDecisions) {
        return res
          .status(400)
          .json({ error: "poDecisions must say VENDOR_AGREED or KEEP_THE_PIECE." });
      }
      const plan = await readCancelPlan(orderId);
      if (plan.held > 0 && !access.holds[REFUNDS]) {
        return res.status(403).json({
          error:
            "This order has money on it, and your role can't give money back. Ask someone who can.",
        });
      }
      if (needsPoCall(plan) && !access.holds[PO_CALL]) {
        return res.status(403).json({
          error:
            "A vendor has acknowledged this order's PO, and your role can't make that call. Ask a manager.",
        });
      }
      const result = await cancelOrder(orderId, {
        reason: typeof body.reason === "string" ? body.reason : "",
        destination: body.destination,
        poDecisions,
        actor: session.user?.email ?? null,
      });
      return res.status(200).json(result);
    }
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    if (err instanceof CancelOrderError) return res.status(err.status).json({ error: err.message });
    if (err instanceof RefundError) {
      return res.status(400).json({
        error: `The order is still open. ${err.message} Anything already refunded stays refunded, and cancelling again refunds only what's left.`,
      });
    }
    if (err instanceof RefundProcessorError) {
      return res.status(502).json({
        error: `The order is still open. ${err.message} Anything already refunded stays refunded, and cancelling again refunds only what's left.`,
      });
    }
    logError("/api/sales/orders/[id]/cancel error", err, { orderId });
    return res.status(500).json({ error: "Couldn't cancel this order." });
  }
}

export default requirePermission("sales.cancel", handler, { also: [REFUNDS, PO_CALL] });
