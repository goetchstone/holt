// /app/src/pages/api/purchasing/import-nuorder.ts
//
// Import a NuORDER wholesale order PDF. Parses vendor, line items with
// per-size breakdowns, creates or matches Products and ProductVariants,
// and generates a PurchaseOrder. Re-importing the same order number
// overwrites the existing PO (supports revised orders).

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { parseNuOrderPDF } from "@/lib/pricing/nuorderParser";
import type { File as FormidableFile } from "formidable";
import fs from "fs";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { createSecureForm } from "@/lib/secureUpload";
import { logError } from "@/lib/logger";
import { getErrorMessage } from "@/lib/toastError";
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
      const parsed = await parseNuOrderPDF(buffer);

      if (!parsed.items.length) {
        return res.status(400).json({ error: "No line items found in PDF" });
      }

      // Find or prompt for vendor
      const vendorName = parsed.vendorName || "Unknown Vendor";
      let vendor = await prisma.vendor.findFirst({
        where: { name: { equals: vendorName, mode: "insensitive" } },
      });

      if (!vendor) {
        vendor = await prisma.vendor.create({
          data: {
            name: vendorName,
            pricingModel: "FLAT",
            createdBy: session.user?.email || "system",
          },
        });
      }

      // Department and category are provided by the user from the preview step
      const departmentId = Number.parseInt(fields.departmentId as string);
      const categoryId = Number.parseInt(fields.categoryId as string);

      // Per-item category overrides: JSON map of item index -> categoryId
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

      const apparelDept = await prisma.department.findUnique({ where: { id: departmentId } });
      if (!apparelDept) return res.status(400).json({ error: "Department not found" });

      const apparelCat = await prisma.category.findUnique({ where: { id: categoryId } });
      if (!apparelCat) return res.status(400).json({ error: "Category not found" });

      // Parse delivery dates
      let expectedDelivery: Date | null = null;
      if (parsed.deliveryEnd) {
        const parts = parsed.deliveryEnd.split("/");
        if (parts.length === 3) {
          expectedDelivery = new Date(
            Number.parseInt(parts[2]),
            Number.parseInt(parts[0]) - 1,
            Number.parseInt(parts[1]),
          );
        }
      }

      // Use the vendor's order number as the PO number
      const poNumber = parsed.poNumber || parsed.orderNumber;
      if (!poNumber) {
        return res.status(400).json({ error: "Could not extract PO or order number from PDF" });
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

          // Find or create the parent product by style number + vendor
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
                departmentId: apparelDept.id,
                categoryId: itemCatId,
                baseCost: item.unitPrice,
                baseRetail: item.msrp,
                isActive: true,
                createdBy: session.user?.email || "system",
              },
            });
            productsCreated++;
          }

          if (item.sizes.length > 0) {
            // Create a PO line item per size
            for (const sizeEntry of item.sizes) {
              // Find or create the variant
              let variant = await tx.productVariant.findFirst({
                where: {
                  productId: product.id,
                  size: sizeEntry.size,
                  color: item.color,
                },
              });

              if (!variant) {
                variant = await tx.productVariant.create({
                  data: {
                    productId: product.id,
                    size: sizeEntry.size,
                    color: item.color,
                    sku: `${item.styleNumber}-${item.colorCode}-${sizeEntry.size}`,
                    cost: item.unitPrice,
                    retail: item.msrp,
                    createdBy: session.user?.email || "system",
                  },
                });
                variantsCreated++;
              }

              poItems.push({
                productId: product.id,
                productVariantId: variant.id,
                partNo: `${item.styleNumber}-${item.colorCode}-${sizeEntry.size}`,
                productName: `${item.productName} - ${item.color} - ${sizeEntry.size}`,
                orderedQuantity: sizeEntry.quantity,
                unitCost: item.unitPrice,
              });
            }
          } else {
            // No size breakdown, single line item
            poItems.push({
              productId: product.id,
              productVariantId: null,
              partNo: item.styleNumber,
              productName: `${item.productName} - ${item.color}`,
              orderedQuantity: item.totalUnits,
              unitCost: item.unitPrice,
            });
          }
        }

        // Create the PO
        const po = await tx.purchaseOrder.create({
          data: {
            poNumber,
            vendorId: vendor!.id,
            orderDate: parsed.orderDate ? new Date(parsed.orderDate) : new Date(),
            expectedDelivery,
            vendorAckNumber: parsed.orderNumber !== poNumber ? parsed.orderNumber : null,
            notes: parsed.terms ? `Terms: ${parsed.terms}` : null,
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
      logError("NuORDER import error", error);
      return res.status(500).json({ error: getErrorMessage(error, "Import failed") });
    }
  },
);
