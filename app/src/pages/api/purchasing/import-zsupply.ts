// /app/src/pages/api/purchasing/import-zsupply.ts
//
// Import a Z Supply invoice PDF. Parses line items with size/color,
// creates or matches Products and ProductVariants, and generates a
// PurchaseOrder. Re-importing the same invoice number overwrites
// the existing PO.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { parseZSupplyPDF } from "@/lib/pricing/zSupplyParser";
import type { File as FormidableFile } from "formidable";
import fs from "fs";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { createSecureForm } from "@/lib/secureUpload";
import { logError } from "@/lib/logger";
export const config = { api: { bodyParser: false } };

async function parseForm(
  req: NextApiRequest,
): Promise<{ file: FormidableFile; fields: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const form = createSecureForm("PDF");
    form.parse(req, (err, rawFields, files) => {
      if (err) return reject(err);
      const file = Array.isArray(files.file) ? files.file[0] : files.file;
      if (!file) return reject(new Error("No file uploaded"));
      const fields: Record<string, string> = {};
      for (const [key, val] of Object.entries(rawFields)) {
        fields[key] = Array.isArray(val) ? val[0] || "" : String(val || "");
      }
      resolve({ file, fields });
    });
  });
}

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    try {
      const { file, fields } = await parseForm(req);
      const buffer = fs.readFileSync(file.filepath);
      const parsed = await parseZSupplyPDF(buffer);

      if (!parsed.items.length) {
        return res.status(400).json({ error: "No line items found in PDF" });
      }

      // Find or create Z Supply vendor
      let vendor = await prisma.vendor.findFirst({
        where: { name: { equals: "Z Supply", mode: "insensitive" } },
      });

      if (!vendor) {
        vendor = await prisma.vendor.create({
          data: {
            name: "Z Supply",
            pricingModel: "FLAT",
            createdBy: session.user?.email || "system",
          },
        });
      }

      const departmentId = Number.parseInt(fields.departmentId as string);
      const categoryId = Number.parseInt(fields.categoryId as string);

      let itemCategories: Record<number, number> = {};
      if (fields.itemCategories) {
        try {
          itemCategories = JSON.parse(fields.itemCategories);
        } catch {
          // ignore parse errors, use defaults
        }
      }

      if (!departmentId || Number.isNaN(departmentId)) {
        return res.status(400).json({ error: "Department is required" });
      }
      if (!categoryId || Number.isNaN(categoryId)) {
        return res.status(400).json({ error: "Category is required" });
      }

      const dept = await prisma.department.findUnique({ where: { id: departmentId } });
      if (!dept) return res.status(400).json({ error: "Department not found" });

      const cat = await prisma.category.findUnique({ where: { id: categoryId } });
      if (!cat) return res.status(400).json({ error: "Category not found" });

      // Use invoice number as the PO number
      const poNumber = parsed.invoiceNumber;
      if (!poNumber) {
        return res.status(400).json({ error: "Could not extract invoice number from PDF" });
      }

      // Parse due date for expected delivery
      let expectedDelivery: Date | null = null;
      if (parsed.dueDate) {
        const parts = parsed.dueDate.split("/");
        if (parts.length === 3) {
          const year = Number.parseInt(parts[2], 10);
          const fullYear = year < 100 ? 2000 + year : year;
          expectedDelivery = new Date(
            fullYear,
            Number.parseInt(parts[0]) - 1,
            Number.parseInt(parts[1]),
          );
        }
      }

      type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

      const result = await prisma.$transaction(async (tx: TxClient) => {
        // Delete existing PO if re-importing
        const existingPO = await tx.purchaseOrder.findUnique({
          where: { poNumber },
          include: { lineItems: true },
        });

        if (existingPO) {
          await tx.purchaseOrderItem.deleteMany({
            where: { purchaseOrderId: existingPO.id },
          });
          await tx.purchaseOrder.delete({ where: { id: existingPO.id } });
        }

        let productsCreated = 0;
        let variantsCreated = 0;
        const poItems: {
          productId: number;
          productVariantId: number | null;
          partNo: string;
          productName: string;
          orderedQuantity: number;
          unitCost: number;
        }[] = [];

        for (let idx = 0; idx < parsed.items.length; idx++) {
          const item = parsed.items[idx];
          const itemCatId = itemCategories[idx] || categoryId;

          // Find or create product by style number + vendor
          let product = await tx.product.findFirst({
            where: {
              productNumber: item.styleNumber,
              vendorId: vendor!.id,
            },
          });

          if (!product) {
            product = await tx.product.create({
              data: {
                productNumber: item.styleNumber,
                name: item.productName,
                vendorId: vendor!.id,
                departmentId: dept.id,
                categoryId: itemCatId,
                baseCost: item.unitPrice,
                isActive: true,
                createdBy: session.user?.email || "system",
              },
            });
            productsCreated++;
          }

          // Create variant for size + color
          let variant = await tx.productVariant.findFirst({
            where: {
              productId: product.id,
              size: item.size || "OS",
              color: item.colorCode,
            },
          });

          if (!variant) {
            variant = await tx.productVariant.create({
              data: {
                productId: product.id,
                size: item.size || "OS",
                color: item.colorCode,
                sku: `${item.styleNumber}-${item.colorCode}-${item.size || "OS"}`,
                cost: item.unitPrice,
                createdBy: session.user?.email || "system",
              },
            });
            variantsCreated++;
          }

          poItems.push({
            productId: product.id,
            productVariantId: variant.id,
            partNo: `${item.styleNumber}-${item.colorCode}-${item.size || "OS"}`,
            productName: `${item.productName} - ${item.colorCode} - ${item.size || "OS"}`,
            orderedQuantity: item.quantity,
            unitCost: item.unitPrice,
          });
        }

        // Create the PO
        const noteParts = [
          parsed.terms ? `Terms: ${parsed.terms}` : null,
          parsed.shipVia ? `Ship via: ${parsed.shipVia}` : null,
          parsed.trackingNumber ? `Tracking: ${parsed.trackingNumber}` : null,
        ].filter(Boolean);

        const po = await tx.purchaseOrder.create({
          data: {
            poNumber,
            vendorId: vendor!.id,
            orderDate: parsed.invoiceDate
              ? (() => {
                  const parts = parsed.invoiceDate.split("/");
                  if (parts.length === 3) {
                    const year = Number.parseInt(parts[2], 10);
                    const fullYear = year < 100 ? 2000 + year : year;
                    return new Date(
                      fullYear,
                      Number.parseInt(parts[0]) - 1,
                      Number.parseInt(parts[1]),
                    );
                  }
                  return new Date();
                })()
              : new Date(),
            expectedDelivery,
            vendorAckNumber: parsed.orderNumber || null,
            notes: noteParts.length ? noteParts.join("; ") : null,
            status: "CONFIRMED",
            createdBy: session.user?.email || "system",
            lineItems: {
              create: poItems.map((pi) => ({
                productId: pi.productId,
                productVariantId: pi.productVariantId,
                partNo: pi.partNo,
                productName: pi.productName,
                orderedQuantity: pi.orderedQuantity,
                unitCost: pi.unitCost,
              })),
            },
          },
          include: { lineItems: true },
        });

        return {
          poId: po.id,
          poNumber: po.poNumber,
          vendor: vendor!.name,
          itemCount: po.lineItems.length,
          productsCreated,
          variantsCreated,
          totalUnits: poItems.reduce((sum, pi) => sum + pi.orderedQuantity, 0),
          totalCost: poItems.reduce((sum, pi) => sum + pi.orderedQuantity * pi.unitCost, 0),
          replaced: !!existingPO,
        };
      }, TX_TIMEOUT.LONG);

      return res.status(200).json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logError("Z Supply import error", error);
      return res.status(500).json({ error: msg || "Import failed" });
    }
  },
);
