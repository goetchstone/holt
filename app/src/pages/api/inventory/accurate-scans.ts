// /app/src/pages/api/inventory/accurate-scans.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
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

  const { location, page = 1, limit = 50, reportType = "general" } = req.query;
  const pageNum = Number.parseInt(page as string, 10);
  const limitNum = Number.parseInt(limit as string, 10);

  if (!location || typeof location !== "string") {
    return res.status(400).json({ error: "A stock location must be provided." });
  }

  try {
    // This logic mirrors the variance-report API to ensure we're looking at the same dataset
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
        const currentCount = countedMap.get(count.product.externalId) || 0;
        countedMap.set(count.product.externalId, currentCount + count.quantity);
      }
    }

    const allExternalIds = Array.from(new Set([...expectedMap.keys(), ...countedMap.keys()]));
    if (allExternalIds.length === 0) {
      return res.status(200).json({ records: [], total: 0 });
    }

    const allProductsInfo = await prisma.product.findMany({
      where: { externalId: { in: allExternalIds } },
      select: {
        externalId: true,
        name: true,
        productNumber: true,
        department: { select: { name: true } },
      },
    });
    const productInfoMap = new Map(allProductsInfo.map((p) => [p.externalId, p]));

    const fullVarianceReport = allExternalIds.map((id) => {
      const product = productInfoMap.get(id);
      const expected = expectedMap.get(id) || 0;
      const counted = countedMap.get(id) || 0;
      return {
        externalId: id,
        productName: product?.name || "Product Not Found",
        productNumber: product?.productNumber || "N/A",
        department: product?.department?.name || "Unknown",
        counted,
        variance: counted - expected,
      };
    });

    let filteredReport;
    if (reportType === "apparel") {
      filteredReport = fullVarianceReport.filter((item) =>
        APPAREL_DEPARTMENTS.includes(item.department),
      );
    } else {
      filteredReport = fullVarianceReport.filter(
        (item) => !APPAREL_DEPARTMENTS.includes(item.department),
      );
    }

    // The key difference: filter for items with ZERO variance
    const accurateItems = filteredReport
      .filter((item) => item.variance === 0)
      .sort((a, b) => a.productName.localeCompare(b.productName));

    const paginatedData = accurateItems.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    res.status(200).json({ records: paginatedData, total: accurateItems.length });
  } catch (error) {
    logError("Failed to fetch accurate scans", error);
    res.status(500).json({ error: "Failed to fetch accurate scans." });
  }
}
