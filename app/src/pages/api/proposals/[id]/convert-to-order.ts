// /app/src/pages/api/proposals/[id]/convert-to-order.ts
//
// POST: Accept a proposal and create a SalesOrder from its line items.
// The proposal's cost/retail are used directly (not from price lists).

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { logger, logError } from "@/lib/logger";

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST"]);
      return res.status(405).end();
    }

    const proposalId = Number.parseInt(req.query.id as string, 10);
    if (Number.isNaN(proposalId)) return res.status(400).json({ error: "Invalid proposal ID" });

    try {
      const result = await prisma.$transaction(async (tx) => {
        const proposal = await tx.proposal.findUnique({
          where: { id: proposalId },
          include: {
            lineItems: {
              orderBy: { sortOrder: "asc" },
              where: { showInOutput: true },
            },
            customer: { select: { id: true, taxExempt: true } },
          },
        });

        if (!proposal) throw new Error("Proposal not found");
        if (proposal.salesOrderId) throw new Error("Proposal already converted to an order");
        if (proposal.lineItems.length === 0) throw new Error("Proposal has no line items");

        // Generate order number
        const now = new Date();
        const yy = String(now.getFullYear()).slice(2);
        const mm = String(now.getMonth() + 1).padStart(2, "0");
        const dd = String(now.getDate()).padStart(2, "0");
        const prefix = `SH-${yy}${mm}${dd}-`;

        const lastOrder = await tx.salesOrder.findFirst({
          where: { orderno: { startsWith: prefix } },
          orderBy: { orderno: "desc" },
          select: { orderno: true },
        });

        let seq = 1;
        if (lastOrder) {
          const lastSeq = Number.parseInt(lastOrder.orderno.replace(prefix, ""), 10);
          if (!Number.isNaN(lastSeq)) seq = lastSeq + 1;
        }
        const orderno = `${prefix}${String(seq).padStart(3, "0")}`;

        const isTaxExempt = proposal.customer?.taxExempt ?? false;

        const order = await tx.salesOrder.create({
          data: {
            orderno,
            status: "ORDER",
            orderDate: now,
            customerId: proposal.customerId,
            salesPersonId: proposal.salesPersonId,
            storeLocation: "B2B",
            orderNotes: proposal.internalNotes
              ? `B2B Proposal ${proposal.proposalNumber}. ${proposal.internalNotes}`
              : `B2B Proposal ${proposal.proposalNumber}`,
            createdBy: session.user?.email ?? null,
          },
        });

        // Create line items from proposal
        for (let i = 0; i < proposal.lineItems.length; i++) {
          const item = proposal.lineItems[i];
          await tx.orderLineItem.create({
            data: {
              salesOrderId: order.id,
              lineNumber: i + 1,
              productId: item.productId,
              vendorStyleId: item.vendorStyleId,
              productName: item.itemName,
              partNo: item.partNumber,
              orderedQuantity: item.quantity,
              netPrice: item.retailPrice,
              cost: item.cost,
              vatRate: isTaxExempt ? 0 : 0.0635,
              vatAmount: isTaxExempt ? 0 : Number(item.retailPrice) * item.quantity * 0.0635,
              selectedGrade: item.selectedGrade,
              selectedFinish: item.selectedFinish,
              selectedOptions: item.selectedOptions,
              source: "ORDER",
            },
          });
        }

        // Mark proposal as accepted
        await tx.proposal.update({
          where: { id: proposalId },
          data: {
            status: "ACCEPTED",
            salesOrderId: order.id,
            acceptedAt: now,
            updatedBy: session.user?.email ?? null,
          },
        });

        return { orderId: order.id, orderno, itemCount: proposal.lineItems.length };
      }, TX_TIMEOUT.SHORT);

      logger.info("Converted proposal to order", {
        proposalId,
        orderId: result.orderId,
        orderno: result.orderno,
      });

      return res.status(201).json(result);
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (
          err.message.includes("not found") ||
          err.message.includes("already converted") ||
          err.message.includes("no line items")
        ) {
          return res.status(400).json({ error: err.message });
        }
      }
      logError("Failed to convert proposal to order", err);
      return res.status(500).json({ error: "Failed to convert proposal to order" });
    }
  },
);
