// /app/src/pages/api/sales/import-hd-proposal.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { parseHDProposal } from "@/lib/pricing/hdProposalParser";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
export const config = { api: { bodyParser: { sizeLimit: "10mb" } } };

function splitCustomerName(fullName: string): { firstName: string; lastName: string } {
  const trimmed = fullName.trim();
  const lastSpace = trimmed.lastIndexOf(" ");
  if (lastSpace < 0) return { firstName: trimmed, lastName: "" };
  return {
    firstName: trimmed.substring(0, lastSpace),
    lastName: trimmed.substring(lastSpace + 1),
  };
}

function parseCityStateZip(csz: string): { city: string; state: string; zip: string } {
  if (!csz) return { city: "", state: "", zip: "" };
  const commaIdx = csz.indexOf(",");
  if (commaIdx < 0) return { city: csz.trim(), state: "", zip: "" };
  const city = csz.substring(0, commaIdx).trim();
  const rest = csz.substring(commaIdx + 1).trim();
  const parts = rest.split(/\s+/);
  const state = parts[0] || "";
  const zip = parts[1] || "";
  return { city, state, zip };
}

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    const { pdfBase64 } = req.body as { pdfBase64?: string };
    if (!pdfBase64) {
      return res.status(400).json({ error: "Missing pdfBase64 field" });
    }

    const userEmail = session.user.email;

    let proposal;
    try {
      const buffer = Buffer.from(pdfBase64, "base64");
      proposal = await parseHDProposal(buffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to parse PDF";
      return res.status(400).json({ error: `PDF parse error: ${message}` });
    }

    if (!proposal.quoteNumber) {
      return res.status(400).json({ error: "Could not extract quote number from PDF" });
    }

    const orderno = `HD-${proposal.quoteNumber}`;

    try {
      const result = await prisma.$transaction(async (tx) => {
        // Find or create Hunter Douglas vendor
        const hdVendor = await tx.vendor.upsert({
          where: { name: "Hunter Douglas" },
          update: {},
          create: { name: "Hunter Douglas", code: "HD", pricingModel: "FLAT" },
        });

        // Find or create Window Treatments department and Blinds & Shades category
        const dept = await tx.department.upsert({
          where: { name: "Window Treatments" },
          update: {},
          create: { name: "Window Treatments", createdBy: userEmail },
        });
        const cat = await tx.category.upsert({
          where: { name_departmentId: { name: "Blinds & Shades", departmentId: dept.id } },
          update: {},
          create: { name: "Blinds & Shades", departmentId: dept.id, createdBy: userEmail },
        });

        // Find or create LABOR-HD product
        let laborProduct = await tx.product.findFirst({
          where: { productNumber: "LABOR-HD", vendorId: hdVendor.id },
        });
        if (!laborProduct) {
          laborProduct = await tx.product.create({
            data: {
              productNumber: "LABOR-HD",
              name: "Installation - Hunter Douglas",
              vendorId: hdVendor.id,
              departmentId: dept.id,
              categoryId: cat.id,
              createdBy: userEmail,
            },
          });
        }

        // Find or create HD-FREIGHT product
        let freightProduct = await tx.product.findFirst({
          where: { productNumber: "HD-FREIGHT", vendorId: hdVendor.id },
        });
        if (!freightProduct) {
          freightProduct = await tx.product.create({
            data: {
              productNumber: "HD-FREIGHT",
              name: "Freight - Hunter Douglas",
              vendorId: hdVendor.id,
              departmentId: dept.id,
              categoryId: cat.id,
              createdBy: userEmail,
            },
          });
        }

        // Find or create customer
        const { firstName, lastName } = splitCustomerName(proposal.customer.name);
        const { city, state, zip } = parseCityStateZip(proposal.customer.cityStateZip);

        let customer = await tx.customer.findFirst({
          where: { firstName, lastName },
        });
        if (!customer) {
          customer = await tx.customer.create({
            data: { firstName, lastName, createdBy: userEmail },
          });
          // Create address if we have one
          if (proposal.customer.street || city) {
            await tx.customerAddress.create({
              data: {
                customerId: customer.id,
                address1: proposal.customer.street || "",
                city,
                state,
                zip,
                label: "Home",
                createdBy: userEmail,
              },
            });
          }
        }

        // Resolve default tax district (CT) and rate unless customer is exempt
        let taxRate = 0;
        let taxDistrictId: number | null = null;
        const defaultDistrict = await tx.taxDistrict.findFirst({
          where: { shortName: "CT", isActive: true },
          include: {
            rules: {
              where: { isActive: true },
              orderBy: { sortOrder: "asc" },
              take: 1,
            },
          },
        });
        if (defaultDistrict && defaultDistrict.rules.length > 0) {
          taxDistrictId = defaultDistrict.id;
          taxRate = Number(defaultDistrict.rules[0].taxRate);
        }

        if (customer.taxExemptReasonId) {
          taxRate = 0;
        }

        // Check for existing order
        const existingOrder = await tx.salesOrder.findUnique({ where: { orderno } });
        const isUpdate = !!existingOrder;

        const orderNotes = [
          `HD Quote: ${proposal.quoteNumber}`,
          proposal.sidemark ? `Sidemark: ${proposal.sidemark}` : null,
          proposal.validThrough ? `Valid through: ${proposal.validThrough}` : null,
          proposal.discountTotal ? `Discount: $${proposal.discountTotal.toFixed(2)}` : null,
        ]
          .filter(Boolean)
          .join(" | ");

        let orderId: number;

        if (existingOrder) {
          // Delete existing line items and recreate
          await tx.orderLineItem.deleteMany({ where: { salesOrderId: existingOrder.id } });
          await tx.salesOrder.update({
            where: { id: existingOrder.id },
            data: {
              customerId: customer.id,
              salesperson: proposal.salesperson || undefined,
              taxDistrictId,
              orderNotes,
              updatedBy: userEmail,
            },
          });
          orderId = existingOrder.id;
        } else {
          const order = await tx.salesOrder.create({
            data: {
              orderno,
              orderDate: new Date(),
              quoteDate: new Date(),
              status: "QUOTE",
              customerId: customer.id,
              salesperson: proposal.salesperson || undefined,
              taxDistrictId,
              orderNotes,
              createdBy: userEmail,
            },
          });
          orderId = order.id;
        }

        // Create line items for each HD product
        let lineNumber = 1;
        for (const item of proposal.items) {
          const sellingPrice = item.extended || item.each * item.qty;
          await tx.orderLineItem.create({
            data: {
              salesOrderId: orderId,
              lineNumber: lineNumber++,
              partNo: `HD-${proposal.quoteNumber}-${item.itemNumber}`,
              productName: `${item.description.substring(0, 80)} [MSRP: $${item.msrp.toFixed(2)}]`,
              netPrice: sellingPrice,
              cost: 0,
              orderedQuantity: item.qty,
              vatRate: taxRate,
              vatAmount: Math.round(sellingPrice * taxRate * 100) / 100,
            },
          });
        }

        // Freight line item (freight is not taxed)
        if (proposal.totalFreight > 0) {
          await tx.orderLineItem.create({
            data: {
              salesOrderId: orderId,
              lineNumber: lineNumber++,
              productId: freightProduct.id,
              productName: "Freight",
              partNo: `HD-${proposal.quoteNumber}-FREIGHT`,
              netPrice: proposal.totalFreight,
              cost: 0,
              orderedQuantity: 1,
              vatRate: 0,
              vatAmount: 0,
            },
          });
        }

        // Installation line item (labor is not taxed)
        if (proposal.totalInstall > 0) {
          await tx.orderLineItem.create({
            data: {
              salesOrderId: orderId,
              lineNumber: lineNumber++,
              productId: laborProduct.id,
              productName: "Installation",
              partNo: `HD-${proposal.quoteNumber}-INSTALL`,
              netPrice: proposal.totalInstall,
              cost: 0,
              orderedQuantity: 1,
              vatRate: 0,
              vatAmount: 0,
            },
          });
        }

        return {
          orderId,
          orderno,
          isUpdate,
          itemCount: proposal.items.length,
          proposal,
        };
      }, TX_TIMEOUT.LONG);

      return res.status(200).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Import failed";
      return res.status(500).json({ error: message });
    }
  },
);
