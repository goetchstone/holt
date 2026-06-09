// /app/src/pages/api/inventory/variance-report.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

const APPAREL_DEPARTMENTS = ["Accessories", "Mens Apparel", "Womens Apparel"];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

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
    // Step 1: Get the externalIds of products that have ALREADY been reconciled for this location.
    // This is the key to fixing the bug.
    const reconciledProducts = await prisma.reconciliation.findMany({
      where: { location },
      select: { product: { select: { externalId: true } } },
    });
    const reconciledExternalIds = new Set(
      reconciledProducts.map((r) => r.product.externalId).filter((id): id is number => id !== null),
    );

    // Step 2: Fetch all snapshot and physical counts for the location.
    const snapshotCounts = await prisma.inventorySnapshot.findMany({
      where: { stockLocation: location },
    });
    const physicalCounts = await prisma.physicalInventoryCount.findMany({
      where: { stockLocation: location },
      include: { product: { select: { externalId: true } } },
    });

    const expectedMap = new Map(snapshotCounts.map((item) => [item.externalId, item.quantity]));
    const countedMap = new Map<number, number>();
    for (const count of physicalCounts) {
      if (count.product.externalId) {
        countedMap.set(
          count.product.externalId,
          (countedMap.get(count.product.externalId) || 0) + count.quantity,
        );
      }
    }

    // Step 3: Get all unique product IDs from both datasets, BUT EXCLUDE the ones that have been reconciled.
    const allExternalIds = Array.from(
      new Set([...expectedMap.keys(), ...countedMap.keys()]),
    ).filter((id) => !reconciledExternalIds.has(id));

    if (allExternalIds.length === 0) {
      const accurateCountResult = await prisma.reconciliation.count({
        where: { location, finalVariance: 0 },
      });
      return res.status(200).json({ records: [], total: 0, accurateCount: accurateCountResult });
    }

    const allProductsInfo = await prisma.product.findMany({
      where: { externalId: { in: allExternalIds } },
      select: {
        externalId: true,
        name: true,
        productNumber: true,
        department: { select: { name: true } },
        upcs: { select: { upc: true }, take: 1 },
      },
    });
    const productInfoMap = new Map(allProductsInfo.map((p) => [p.externalId, p]));

    const varianceReport = allExternalIds.map((id) => {
      const product = productInfoMap.get(id);
      const expected = expectedMap.get(id) || 0;
      const counted = countedMap.get(id) || 0;
      return {
        externalId: id,
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
      const aVal = sortBy === "variance" ? Math.abs(a.variance) : a[sortBy as keyof typeof a];
      const bVal = sortBy === "variance" ? Math.abs(b.variance) : b[sortBy as keyof typeof b];
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
