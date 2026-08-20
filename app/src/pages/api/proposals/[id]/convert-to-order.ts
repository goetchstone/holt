// /app/src/pages/api/proposals/[id]/convert-to-order.ts
//
// POST: Accept a proposal and create a SalesOrder from its line items.
// The proposal's cost/retail are used directly (not from price lists).

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { logger, logError } from "@/lib/logger";
import { resolveTaxDistrict, rateForLineAmount } from "@/lib/tax/resolveTaxRate";

const round2 = (n: number): number => Math.round(n * 100) / 100;

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

        // Tax comes from the configured district, never a literal. A B2B
        // proposal has no selling store, so this resolves through the
        // customer's own district and then the deployment default -- see
        // lib/tax/resolveTaxRate.ts for the full order. This used to be a bare
        // rate written twice: one deployment's Connecticut rate compiled into
        // the product, charging every other deployment's customers CT tax.
        const taxDistrict = await resolveTaxDistrict(tx, {
          customerId: proposal.customerId,
          storeLocationId: null,
          contextLabel: `B2B proposal ${proposal.proposalNumber}`,
        });
        // Customer.taxExempt (boolean) and Customer.taxExemptReasonId are two
        // separate columns for the same question. resolveTaxDistrict reads the
        // reason id; this path historically read the boolean. Honouring EITHER
        // keeps both readings exempt rather than letting one silently tax a
        // customer the other considers exempt.
        const isTaxExempt = (proposal.customer?.taxExempt ?? false) || taxDistrict.isExempt;

        const order = await tx.salesOrder.create({
          data: {
            orderno,
            status: "ORDER",
            orderDate: now,
            taxDistrictId: taxDistrict.taxDistrictId,
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
          const lineTotal = round2(Number(item.retailPrice) * item.quantity);
          // Banded against this line's own amount: a TaxRule may gate on
          // triggerPrice/startPrice, so the rate is per line, not per order.
          const lineRate = isTaxExempt ? 0 : rateForLineAmount(taxDistrict.rules, lineTotal).rate;
          await tx.orderLineItem.create({
            data: {
              salesOrderId: order.id,
              lineNumber: i + 1,
              productId: item.productId,
              vendorStyleId: item.vendorStyleId,
              productName: item.itemName,
              partNo: item.partNumber,
              orderedQuantity: item.quantity,
              // LINE totals, not unit prices. ProposalLineItem.retailPrice and
              // .cost are per-unit ("$X each x N" in the proposal PDF), while
              // OrderLineItem.netPrice/cost are line totals summed directly by
              // every report (lib/pos/cartPricing.ts: "netPrice is the LINE
              // total, never the unit price"). Writing the unit price here
              // understated revenue and COGS by (quantity - 1) x unit on every
              // multi-quantity line, while tax was computed on the full line --
              // so the two disagreed on the same row.
              netPrice: lineTotal,
              cost: round2(Number(item.cost ?? 0) * item.quantity),
              vatRate: lineRate,
              vatAmount: round2(lineTotal * lineRate),
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
