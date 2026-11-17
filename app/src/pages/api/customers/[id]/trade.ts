// /app/src/pages/api/customers/[id]/trade.ts
//
// A customer's trade account and tax exemption. Their trade tier prices every
// eligible line of their sales below retail with no manager's PIN (GAP-06 part
// C), so it is given through lib/customers/tradeTierAssignment.ts: only an
// active tier, and each change recorded, in the same transaction as the save.
//
// Still on the MANAGER/ADMIN role array (__tests__/fixtures/role-array-api-routes.txt):
// no permission covers both what it sets -- a standing discount and a tax
// exemption -- and choosing one is a decision about who may do either.

import { NextApiRequest, NextApiResponse } from "next";
import { Session } from "next-auth";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { auditActor } from "@/lib/audit";
import { logError } from "@/lib/logger";
import {
  TradeTierAssignmentError,
  setCustomerTradeTier,
} from "@/lib/customers/tradeTierAssignment";

/** Exported for integration tests, which call it with a fake session -- the
 *  role gate needs real cookies. Same pattern as create-from-cart.ts. */
export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "PUT") {
    res.setHeader("Allow", "PUT");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const customerId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(customerId)) {
    return res.status(400).json({ error: "Invalid customer ID" });
  }

  return handlePut(customerId, req, res, session);
}

export default requireAuthWithRole(["MANAGER", "ADMIN"], handler);

async function handlePut(
  customerId: number,
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
) {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) {
    return res.status(404).json({ error: "Customer not found" });
  }

  const { tradeTierId, isTradeAccount, tradeCompanyName, taxExemptNumber, taxExemptReasonId } =
    req.body;

  // The customer's tax exemption: a reason makes every later sale exempt
  // (lib/tax/resolveTaxRate.ts), null taxes them again. Orders already written
  // keep the exemption they were sold under.
  if (taxExemptReasonId != null) {
    const reasonId = Number(taxExemptReasonId);
    if (!Number.isInteger(reasonId)) {
      return res.status(400).json({ error: "Tax exempt reason must be a reason id" });
    }
    const reason = await prisma.taxExemptReason.findUnique({ where: { id: reasonId } });
    if (!reason) {
      return res.status(400).json({ error: "Tax exempt reason not found" });
    }
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (tradeTierId !== undefined) {
        await setCustomerTradeTier(tx, {
          customerId,
          tradeTierId,
          actor: auditActor(session),
        });
      }
      return tx.customer.update({
        where: { id: customerId },
        data: {
          ...(isTradeAccount != null && { isTradeAccount }),
          ...(tradeCompanyName !== undefined && { tradeCompanyName: tradeCompanyName || null }),
          ...(taxExemptNumber !== undefined && { taxExemptNumber: taxExemptNumber || null }),
          ...(taxExemptReasonId !== undefined && {
            taxExemptReasonId: taxExemptReasonId == null ? null : Number(taxExemptReasonId),
          }),
          updatedBy: session.user?.email || undefined,
        },
        include: {
          tradeTier: true,
          taxExemptReason: true,
        },
      });
    });
    return res.json(updated);
  } catch (error) {
    if (error instanceof TradeTierAssignmentError) {
      return res.status(error.status).json({ error: error.message });
    }
    logError("Update customer trade details failed", error);
    return res.status(500).json({ error: "Failed to save the customer's trade details" });
  }
}
