// /app/src/pages/api/inventory/variance-report.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { resolveStoreLocationId } from "@/lib/storeLocationResolver";

const APPAREL_DEPARTMENTS = ["Accessories", "Mens Apparel", "Womens Apparel"];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const {
    location,
    page = 1,
    limit = 8,
    reportType = "general",
    sortBy = "variance",
    sortOrder = "desc",
  } = req.query;
  const pageNum = Number.parseInt(page as string, 10);
  const limitNum = Number.parseInt(limit as string, 10);

  if (!location || typeof location !== "string") {
    return res.status(400).json({ error: "A stock location must be provided." });
  }

  try {
    // Step 1: Get the products that have ALREADY been reconciled for this location.
    // This is the key to fixing the bug.
    const reconciledProducts = await prisma.reconciliation.findMany({
      where: { location },
      select: { productId: true },
    });
    const reconciledProductIds = new Set(reconciledProducts.map((r) => r.productId));

    // Step 2: Fetch all snapshot and physical counts for the location.
    // InventorySnapshot's counting grain is storeLocationId (see its schema
    // comment), not the free-text PhysicalInventoryCount.stockLocation string
    // this page's location picker deals in, so resolve the name first.
    const storeLocationId = await resolveStoreLocationId(location);
    const snapshotCounts = storeLocationId
      ? await prisma.inventorySnapshot.findMany({ where: { storeLocationId } })
      : [];
    const physicalCounts = await prisma.physicalInventoryCount.findMany({
      where: { stockLocation: location },
      select: { productId: true, quantity: true },
    });

    const expectedMap = new Map(snapshotCounts.map((item) => [item.productId, item.quantity]));
    const countedMap = new Map<number, number>();
    for (const count of physicalCounts) {
      countedMap.set(count.productId, (countedMap.get(count.productId) || 0) + count.quantity);
    }

    // Step 3: Get all unique product IDs from both datasets, BUT EXCLUDE the ones that have been reconciled.
    // Keyed on productId (holt's own identity) rather than externalId --
    // externalId is null for every product created natively in holt, which
    // used to make this filter silently drop them from the report entirely.
    const allProductIds = Array.from(new Set([...expectedMap.keys(), ...countedMap.keys()])).filter(
      (id) => !reconciledProductIds.has(id),
    );

    if (allProductIds.length === 0) {
      const accurateCountResult = await prisma.reconciliation.count({
        where: { location, finalVariance: 0 },
      });
      return res.status(200).json({ records: [], total: 0, accurateCount: accurateCountResult });
    }

    const allProductsInfo = await prisma.product.findMany({
      where: { id: { in: allProductIds } },
      select: {
        id: true,
        externalId: true,
        name: true,
        productNumber: true,
        department: { select: { name: true } },
        upcs: { select: { upc: true }, take: 1 },
      },
    });
    const productInfoMap = new Map(allProductsInfo.map((p) => [p.id, p]));

    const varianceReport = allProductIds.map((id) => {
      const product = productInfoMap.get(id);
      const expected = expectedMap.get(id) || 0;
      const counted = countedMap.get(id) || 0;
      return {
        productId: id,
        // Nullable now -- native-born products have no POS id. Consumers
        // (the product-variance drill-down link) must handle null.
        externalId: product?.externalId ?? null,
        productName: product?.name || "Product Not Found",
        productNumber: product?.productNumber || "N/A",
        barcode: product?.upcs[0]?.upc || "N/A",
        department: product?.department?.name || "Unknown",
        expected,
        counted,
        variance: counted - expected,
        status: "pending" as "pending" | "reconciled",
      };
    });

    let filteredReport;
    if (reportType === "apparel") {
      filteredReport = varianceReport.filter((item) =>
        APPAREL_DEPARTMENTS.includes(item.department),
      );
    } else {
      filteredReport = varianceReport.filter(
        (item) => !APPAREL_DEPARTMENTS.includes(item.department),
      );
    }

    const discrepancies = filteredReport.filter((item) => item.variance !== 0);
    const accurateItemsInSnapshot = filteredReport.length - discrepancies.length;
    const accurateItemsReconciled = await prisma.reconciliation.count({
      where: { location, finalVariance: 0 },
    });
    const accurateCount = accurateItemsInSnapshot + accurateItemsReconciled;

    discrepancies.sort((a, b) => {
      // externalId is nullable now (native-born products have none) -- ?? 0
      // is a sort-stability fallback only. It's not a sortable column in the
      // UI (buildVarianceColumns never offers it as a sort key).
      const aVal =
        sortBy === "variance" ? Math.abs(a.variance) : (a[sortBy as keyof typeof a] ?? 0);
      const bVal =
        sortBy === "variance" ? Math.abs(b.variance) : (b[sortBy as keyof typeof b] ?? 0);
      if (aVal < bVal) return sortOrder === "asc" ? -1 : 1;
      if (aVal > bVal) return sortOrder === "asc" ? 1 : -1;
      return 0;
    });

    const paginatedData = discrepancies.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    res.status(200).json({ records: paginatedData, total: discrepancies.length, accurateCount });
  } catch (error) {
    logError("Failed to generate variance report", error);
    res.status(500).json({ error: "Failed to generate variance report." });
  }
}

export default requirePermission("inventory.read", handler);
