// /app/src/pages/api/sales/orders/create-from-cart.ts
//
// Creates a SalesOrder from a POS or quote cart. Generates a sequential order
// number (SH-YYMMDD-NNN). For CONFIGURED and CUSTOM line items, creates a new
// Product record so the item exists in the catalog for reporting, inventory,
// and reorder purposes.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { priceCart, type CartDiscount } from "@/lib/pos/cartPricing";

interface CartItem {
  type?: "PRODUCT" | "CONFIGURED" | "CUSTOM";
  productId?: number;
  productNumber?: string;
  quantity: number;
  unitPrice: number;
  cost?: number;
  name?: string;
  description?: string;
  vendor?: string;
  source?: string;
  fulfillment?: string;
  /** Item-level discounts, applied in order by cartPricing.priceCart. */
  discounts?: CartDiscount[];
  /** A return line; priceCart negates it and excludes it from discount allocation. */
  isReturn?: boolean;
}

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { customerId, items, storeLocation, orderNotes, deliveryMethod, orderDiscount } =
    req.body as {
      customerId?: number | null;
      items: CartItem[];
      storeLocation?: string;
      orderNotes?: string;
      deliveryMethod?: "TAKEN" | "PICKUP" | "DELIVERY";
      orderDiscount?: CartDiscount | null;
    };

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Cart must contain at least one item" });
  }

  try {
    const order = await prisma.$transaction(async (tx) => {
      // Generate order number: SH-YYMMDD-NNN
      const now = new Date();
      const yy = now.getFullYear().toString().slice(-2);
      const mm = (now.getMonth() + 1).toString().padStart(2, "0");
      const dd = now.getDate().toString().padStart(2, "0");
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

      const orderno = `${prefix}${seq.toString().padStart(3, "0")}`;

      // Pre-load existing products (for PRODUCT-type items and as source for CONFIGURED items)
      const allProductIds = items.filter((i) => i.productId).map((i) => i.productId!);
      const existingProducts = await tx.product.findMany({
        where: { id: { in: allProductIds } },
        select: {
          id: true,
          productNumber: true,
          name: true,
          vendorId: true,
          departmentId: true,
          categoryId: true,
          typeId: true,
          baseCost: true,
        },
      });
      const productMap = new Map(existingProducts.map((p) => [p.id, p]));

      // Resolve vendor IDs for configured/custom items
      const vendorNames = [...new Set(items.filter((i) => i.vendor).map((i) => i.vendor!))];
      const vendors = await tx.vendor.findMany({
        where: { name: { in: vendorNames, mode: "insensitive" } },
        select: { id: true, name: true },
      });
      const vendorMap = new Map(vendors.map((v) => [v.name.toLowerCase(), v.id]));

      // Resolve salesperson from session
      const staff = await tx.staffMember.findFirst({
        where: { email: session.user?.email || "" },
        select: { displayName: true },
      });

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

      // Check if customer has a tax exemption
      if (customerId) {
        const customer = await tx.customer.findUnique({
          where: { id: customerId },
          select: { taxExemptReasonId: true },
        });
        if (customer?.taxExemptReasonId) {
          taxRate = 0;
        }
      }

      // Price the whole cart through the shared module so this order's
      // numbers can never diverge from what the POS charged the customer.
      // `item.quantity` here may already be negative for a return (see the
      // client's create-from-cart call), but priceCart derives sign from
      // `isReturn` itself -- feeding it a pre-negated quantity would negate
      // twice, so it's normalized to a magnitude first. `orderedQuantity`
      // below still stores the signed value; only the money math changes.
      const priced = priceCart(
        items.map((item) => ({
          unitPrice: item.unitPrice,
          quantity: Math.abs(item.quantity),
          discounts: item.discounts,
          isReturn: item.isReturn,
        })),
        { taxRate, orderDiscount },
      );

      // Build line items, creating products as needed
      const lineItemData = [];

      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const itemType = item.type || "PRODUCT";
        let productId = item.productId || null;
        let partNo = item.productNumber || null;
        let productName = item.name || null;

        if (itemType === "PRODUCT" && productId) {
          // Existing product -- use catalog data
          const existing = productMap.get(productId);
          if (existing) {
            partNo = existing.productNumber;
            productName = item.name || existing.name;
          }
        } else if (itemType === "CONFIGURED" || itemType === "CUSTOM") {
          // For configured items, inherit dept/category from the source product.
          // For custom items or when source is missing, use a fallback.
          const sourceProduct = productId ? productMap.get(productId) : null;
          const resolvedVendorId = item.vendor
            ? vendorMap.get(item.vendor.toLowerCase()) || sourceProduct?.vendorId
            : sourceProduct?.vendorId;

          // Ensure we have a vendor -- create one if the name was provided but not found
          let finalVendorId = resolvedVendorId || null;
          if (!finalVendorId && item.vendor) {
            const created = await tx.vendor.create({
              data: { name: item.vendor, createdBy: session.user?.email || null },
            });
            finalVendorId = created.id;
          }

          // Fall back to an "Uncategorized" department/category if source product unavailable
          const deptId =
            sourceProduct?.departmentId || (await getOrCreateDefault(tx, "department"));
          const catId = sourceProduct?.categoryId || (await getOrCreateDefault(tx, "category"));

          // Generate a unique product number
          const baseNumber = partNo || item.name?.substring(0, 20).replace(/\s+/g, "-") || "CUSTOM";
          const timestamp = Date.now().toString(36).toUpperCase();
          const uniqueNumber = `${baseNumber}-${timestamp}`;

          const newProduct = await tx.product.create({
            data: {
              productNumber: uniqueNumber,
              name: productName || "Custom Item",
              description: item.description || null,
              vendorId: finalVendorId || (await getOrCreateDefaultVendor(tx)),
              departmentId: deptId,
              categoryId: catId,
              typeId: sourceProduct?.typeId || null,
              baseCost: item.cost ?? 0,
              baseRetail: item.unitPrice,
              createdBy: session.user?.email || null,
            },
          });

          productId = newProduct.id;
          partNo = newProduct.productNumber;
        }

        // Use explicitly passed cost (from configurator), or fall back to product baseCost
        const resolvedProduct = productId ? productMap.get(productId) : null;
        const itemCost =
          item.cost != null && item.cost > 0
            ? item.cost
            : resolvedProduct?.baseCost
              ? Number(resolvedProduct.baseCost)
              : 0;

        lineItemData.push({
          lineNumber: idx + 1,
          productId,
          productName: productName || "Unknown",
          partNo: partNo || "",
          orderedQuantity: item.quantity,
          // netPrice/vatAmount come from priceCart, not a re-derivation here --
          // that duplication is exactly how the client and server used to
          // disagree. netPrice already reflects item + order discounts.
          netPrice: priced.items[idx].netPrice,
          // itemCost is per-unit (configurator value or product baseCost);
          // OrderLineItem.cost stores the LINE total, like netPrice.
          cost: itemCost * item.quantity,
          barcode: "",
          vatRate: taxRate,
          vatAmount: priced.items[idx].vatAmount,
          selectedGrade: item.description || null,
          source: item.source || null,
          fulfillment: item.fulfillment || null,
        });
      }

      const created = await tx.salesOrder.create({
        data: {
          orderno,
          orderDate: now,
          quoteDate: now,
          status: "QUOTE",
          customerId: customerId || null,
          taxDistrictId: taxDistrictId,
          salesperson: staff?.displayName || session.user?.email || null,
          storeLocation: storeLocation || null,
          orderNotes: orderNotes || null,
          deliveryMethod: deliveryMethod || null,
          createdBy: session.user?.email || null,
          totalTax: priced.taxAmount,
          // NOTE: SalesOrder/OrderLineItem have no discount column, so the
          // discount amount is not persisted as its own field -- it's only
          // recoverable as subtotal minus the sum of line netPrice. Adding
          // one is a schema change out of scope here; flagging it rather
          // than adding a migration.
          lineItems: { create: lineItemData },
        },
        select: {
          id: true,
          orderno: true,
          status: true,
        },
      });

      return {
        ...created,
        subtotal: priced.subtotal,
        orderDiscountAmount: priced.orderDiscountAmount,
        taxAmount: priced.taxAmount,
        total: priced.total,
      };
    });

    return res.status(201).json(order);
  } catch (error) {
    logError("Create order from cart error", error);
    return res.status(500).json({ error: "Failed to create order" });
  }
}

export default requireAuthWithRole(["DESIGNER", "REGISTER", "MANAGER", "ADMIN"], handler);

// Finds or creates a default "Uncategorized" department or category
async function getOrCreateDefault(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  type: "department" | "category",
): Promise<number> {
  if (type === "department") {
    const existing = await tx.department.findFirst({ where: { name: "Uncategorized" } });
    if (existing) return existing.id;
    const created = await tx.department.create({ data: { name: "Uncategorized" } });
    return created.id;
  }
  // category requires a departmentId
  const deptId = await getOrCreateDefault(tx, "department");
  const existing = await tx.category.findFirst({ where: { name: "Uncategorized" } });
  if (existing) return existing.id;
  const created = await tx.category.create({
    data: { name: "Uncategorized", departmentId: deptId },
  });
  return created.id;
}

async function getOrCreateDefaultVendor(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
): Promise<number> {
  const existing = await tx.vendor.findFirst({ where: { name: "Custom" } });
  if (existing) return existing.id;
  const created = await tx.vendor.create({ data: { name: "Custom" } });
  return created.id;
}
