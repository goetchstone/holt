// /app/src/pages/api/customers/[id]/trade.ts

import { NextApiRequest, NextApiResponse } from "next";
import { Session } from "next-auth";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

export default requireAuthWithRole(["MANAGER", "ADMIN"], async (req, res, session) => {
  if (req.method !== "PUT") {
    res.setHeader("Allow", "PUT");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const customerId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(customerId)) {
    return res.status(400).json({ error: "Invalid customer ID" });
  }

  return handlePut(customerId, req, res, session);
});

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

  // Validate tier exists if provided
  if (tradeTierId != null) {
    const tier = await prisma.tradeTier.findUnique({ where: { id: Number(tradeTierId) } });
    if (!tier) {
      return res.status(400).json({ error: "Trade tier not found" });
    }
  }

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

  const updated = await prisma.customer.update({
    where: { id: customerId },
    data: {
      ...(isTradeAccount != null && { isTradeAccount }),
      ...(tradeTierId !== undefined && { tradeTierId: tradeTierId ? Number(tradeTierId) : null }),
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

  return res.json(updated);
}
