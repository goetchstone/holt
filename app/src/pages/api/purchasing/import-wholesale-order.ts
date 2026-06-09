// /app/src/pages/api/purchasing/import-wholesale-order.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getCellValue } from "@/lib/excelUtils";
import { safeFloat, safeString } from "@/lib/fmSafeMapper";
import { generateBarcode } from "@/lib/barcode";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
export const config = { api: { bodyParser: { sizeLimit: "20mb" } } };

interface ImportRow {
  [key: string]: unknown;
}

// Column alias maps for flexible CSV compatibility (NuOrder, JOOR, manual exports)
const COL = {
  vendor: ["Vendor", "vendor", "Brand", "brand", "Supplier", "supplier"],
  productNumber: [
    "Style",
    "style",
    "SKU",
    "sku",
    "Style #",
    "StyleNumber",
    "ProductNumber",
    "part_no",
    "partNo",
    "Item #",
    "Item Number",
  ],
  productName: [
    "Description",
    "description",
    "Product",
    "product",
    "Product Name",
    "ProductName",
    "name",
    "Style Name",
    "Item Description",
  ],
  quantity: [
    "Qty",
    "qty",
    "QTY",
    "Quantity",
    "quantity",
    "Units",
    "units",
    "Order Qty",
    "Order QTY",
    "ORDER QTY",
    "Ordered Qty",
    "Ordered QTY",
    "Ordered",
    "ordered",
    "Order Quantity",
    "Ordered Quantity",
    "Total Qty",
    "Total QTY",
    "Total Quantity",
    "total_qty",
    "QTY Ordered",
    "Qty Ordered",
    "# Units",
    "No. of Units",
  ],
  cost: [
    "Wholesale",
    "wholesale",
    "Cost",
    "cost",
    "Unit Cost",
    "unitCost",
    "Price",
    "Wholesale Price",
  ],
  retail: ["Retail", "retail", "MSRP", "msrp", "Retail Price", "retailPrice", "Suggested Retail"],
  upc: ["UPC", "upc", "Barcode", "barcode", "EAN", "ean", "GTIN", "gtin"],
  color: ["Color", "color", "Colorway", "colorway", "Color Name"],
  size: ["Size", "size", "Dimension", "dimension"],
  department: ["Department", "department", "Division", "division"],
  category: ["Category", "category", "SubFamily", "Collection", "collection"],
  type: ["Type", "type", "SubCategory"],
  season: ["Season", "season", "Family", "Delivery", "delivery", "Ship Window"],
  notes: ["Notes", "notes", "Comments", "comments", "Order Notes"],
};

async function findOrCreateVendor(name: string, createdBy: string | null) {
  let vendor = await prisma.vendor.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
  });
  if (!vendor) {
    vendor = await prisma.vendor.create({
      data: { name, pricingModel: "FLAT", createdBy },
    });
  }
  return vendor;
}

async function findOrCreateDepartment(name: string) {
  let dept = await prisma.department.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
  });
  if (!dept) {
    dept = await prisma.department.create({ data: { name } });
  }
  return dept;
}

async function findOrCreateCategory(name: string, departmentId: number) {
  let cat = await prisma.category.findFirst({
    where: { name: { equals: name, mode: "insensitive" }, departmentId },
  });
  if (!cat) {
    cat = await prisma.category.create({ data: { name, departmentId } });
  }
  return cat;
}

function generatePONumber(): string {
  const now = new Date();
  const yy = now.getFullYear().toString().slice(-2);
  const mm = (now.getMonth() + 1).toString().padStart(2, "0");
  const dd = now.getDate().toString().padStart(2, "0");
  return `PO-${yy}${mm}${dd}`;
}

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST"]);
      return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    const { rows, defaultVendor, defaultDepartment, defaultCategory } = req.body as {
      rows: ImportRow[];
      defaultVendor?: string;
      defaultDepartment?: string;
      defaultCategory?: string;
    };

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "No rows provided." });
    }

    const changedBy = session.user?.email || null;
    const errors: string[] = [];
    const warnings: string[] = [];
    let productsCreated = 0;
    let productsExisting = 0;

    try {
      // Group rows by vendor to create one PO per vendor
      const vendorGroups = new Map<
        string,
        { vendorId: number; items: { row: ImportRow; productId: number; partNo: string }[] }
      >();

      // Cache lookups
      const vendorCache = new Map<string, { id: number }>();
      const deptCache = new Map<string, { id: number }>();
      const catCache = new Map<string, { id: number }>();

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        try {
          const vendorName = safeString(getCellValue(row, COL.vendor)) || defaultVendor || "";
          if (!vendorName) {
            errors.push(`Row ${i + 1}: No vendor specified.`);
            continue;
          }

          const partNo = safeString(getCellValue(row, COL.productNumber));
          if (!partNo) {
            errors.push(`Row ${i + 1}: No product number/SKU.`);
            continue;
          }

          const productName = safeString(getCellValue(row, COL.productName)) || partNo;
          const rawQty = getCellValue(row, COL.quantity);
          const quantity = safeFloat(rawQty) || 1;
          if (!rawQty) {
            warnings.push(`Row ${i + 1} (${partNo}): No quantity column found, defaulting to 1.`);
          }
          const cost = safeFloat(getCellValue(row, COL.cost)) || 0;
          const retail = safeFloat(getCellValue(row, COL.retail)) || 0;
          const upc = safeString(getCellValue(row, COL.upc));
          const color = safeString(getCellValue(row, COL.color));
          const size = safeString(getCellValue(row, COL.size));
          const deptName =
            safeString(getCellValue(row, COL.department)) || defaultDepartment || "Uncategorized";
          const catName =
            safeString(getCellValue(row, COL.category)) || defaultCategory || "General";
          const season = safeString(getCellValue(row, COL.season));

          // Build full product name with color/size if present
          const fullName = [productName, color, size].filter(Boolean).join(" - ");
          // Build a unique product number with color/size suffix
          const fullPartNo = [partNo, color, size].filter(Boolean).join("-");

          // Resolve vendor
          let vendor = vendorCache.get(vendorName.toLowerCase());
          if (!vendor) {
            const v = await findOrCreateVendor(vendorName, changedBy);
            vendor = { id: v.id };
            vendorCache.set(vendorName.toLowerCase(), vendor);
          }

          // Resolve department
          let dept = deptCache.get(deptName.toLowerCase());
          if (!dept) {
            const d = await findOrCreateDepartment(deptName);
            dept = { id: d.id };
            deptCache.set(deptName.toLowerCase(), dept);
          }

          // Resolve category
          const catKey = `${deptName.toLowerCase()}::${catName.toLowerCase()}`;
          let cat = catCache.get(catKey);
          if (!cat) {
            const c = await findOrCreateCategory(catName, dept.id);
            cat = { id: c.id };
            catCache.set(catKey, cat);
          }

          // Find or create product
          let product = await prisma.product.findFirst({
            where: { productNumber: fullPartNo, vendorId: vendor.id },
          });

          if (!product) {
            product = await prisma.product.create({
              data: {
                productNumber: fullPartNo,
                name: fullName,
                vendorId: vendor.id,
                departmentId: dept.id,
                categoryId: cat.id,
                baseCost: cost,
                baseRetail: retail || undefined,
                season: season || undefined,
                isActive: true,
                createdBy: changedBy,
              },
            });

            // Generate system barcode
            const sysBarcode = generateBarcode(vendor.id, product.id);
            await prisma.upc.create({
              data: {
                upc: sysBarcode,
                productId: product.id,
                source: "SYSTEM",
                sortOrder: 0,
                createdBy: changedBy,
              },
            });

            productsCreated++;
          } else {
            productsExisting++;
          }

          // Add manufacturer UPC if provided and not already stored
          if (upc) {
            const existing = await prisma.upc.findUnique({ where: { upc } });
            if (!existing) {
              const maxSort = await prisma.upc.findFirst({
                where: { productId: product.id },
                orderBy: { sortOrder: "desc" },
              });
              await prisma.upc.create({
                data: {
                  upc,
                  productId: product.id,
                  source: "MANUFACTURER",
                  sortOrder: (maxSort?.sortOrder || 0) + 1,
                  createdBy: changedBy,
                },
              });
            }
          }

          // Group by vendor for PO creation
          const vendorKey = vendorName.toLowerCase();
          if (!vendorGroups.has(vendorKey)) {
            vendorGroups.set(vendorKey, { vendorId: vendor.id, items: [] });
          }
          vendorGroups.get(vendorKey)!.items.push({
            row,
            productId: product.id,
            partNo: fullPartNo,
          });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error";
          errors.push(`Row ${i + 1}: ${message}`);
        }
      }

      // Create one PO per vendor
      const createdPOs: { id: number; poNumber: string; vendor: string; itemCount: number }[] = [];

      for (const [vendorKey, group] of vendorGroups) {
        const poPrefix = generatePONumber();

        // Find next sequence number for this prefix
        const lastPO = await prisma.purchaseOrder.findFirst({
          where: { poNumber: { startsWith: `${poPrefix}-` } },
          orderBy: { poNumber: "desc" },
          select: { poNumber: true },
        });
        let poSeq = 1;
        if (lastPO) {
          const lastSeq = Number.parseInt(lastPO.poNumber.replace(`${poPrefix}-`, ""), 10);
          if (!Number.isNaN(lastSeq)) poSeq = lastSeq + 1;
        }
        const poNumber = `${poPrefix}-${poSeq.toString().padStart(3, "0")}`;

        const po = await prisma.purchaseOrder.create({
          data: {
            poNumber,
            vendorId: group.vendorId,
            status: "DRAFT",
            orderDate: new Date(),
            notes: `Imported from wholesale order CSV`,
            createdBy: changedBy,
            lineItems: {
              create: group.items.map((item, idx) => ({
                productId: item.productId,
                partNo: item.partNo,
                productName: safeString(getCellValue(item.row, COL.productName)) || item.partNo,
                orderedQuantity: safeFloat(getCellValue(item.row, COL.quantity)) || 1,
                unitCost: safeFloat(getCellValue(item.row, COL.cost)) || 0,
                createdBy: changedBy,
              })),
            },
          },
        });

        createdPOs.push({
          id: po.id,
          poNumber: po.poNumber,
          vendor: vendorKey,
          itemCount: group.items.length,
        });
      }

      // Deduplicate quantity warnings: if every row triggered the same warning,
      // collapse into a single message so the response stays readable.
      let quantityWarnings: string[] = [];
      const qtyDefaultCount = warnings.filter((w) => w.includes("No quantity column found")).length;
      if (qtyDefaultCount === rows.length && qtyDefaultCount > 0) {
        quantityWarnings = [
          `No quantity column matched in any of the ${rows.length} rows -- all quantities defaulted to 1. ` +
            `Recognized headers: ${COL.quantity.slice(0, 8).join(", ")}, etc.`,
        ];
      } else {
        quantityWarnings = warnings;
      }

      return res.status(200).json({
        success: true,
        purchaseOrders: createdPOs,
        productsCreated,
        productsExisting,
        totalRows: rows.length,
        errors: errors.length > 0 ? errors : undefined,
        warnings: quantityWarnings.length > 0 ? quantityWarnings : undefined,
      });
    } catch (error) {
      logError("Error importing wholesale order", error);
      return res.status(500).json({ error: "Failed to import wholesale order." });
    }
  },
);
