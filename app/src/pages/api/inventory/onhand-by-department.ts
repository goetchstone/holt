// /app/src/pages/api/inventory/onhand-by-department.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "GET") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  try {
    // Fetch all necessary data in parallel
    const [snapshotRecords, physicalCounts, reconciliations, allProducts, departments] =
      await Promise.all([
        prisma.inventorySnapshot.findMany({ select: { externalId: true, quantity: true } }),
        prisma.physicalInventoryCount.findMany({ select: { productId: true, quantity: true } }),
        prisma.reconciliation.findMany({ include: { product: { select: { externalId: true } } } }),
        prisma.product.findMany({
          select: {
            id: true,
            externalId: true,
            baseCost: true,
            baseRetail: true,
            departmentId: true,
          },
        }),
        prisma.department.findMany({ select: { id: true, name: true } }),
      ]);

    // Build department name lookup
    const deptNameMap = new Map(departments.map((d) => [d.id, d.name]));

    // Create efficient lookup maps
    const productInfoMap = new Map<
      number,
      {
        baseCost: Prisma.Decimal | null;
        baseRetail: Prisma.Decimal | null;
        departmentName: string;
        externalId: number | null;
      }
    >();
    allProducts.forEach((p) => {
      const deptName = deptNameMap.get(p.departmentId);
      if (deptName) {
        productInfoMap.set(p.id, {
          baseCost: p.baseCost,
          baseRetail: p.baseRetail,
          departmentName: deptName,
          externalId: p.externalId,
        });
      }
    });

    const externalToProductIdMap = new Map<number, number>();
    allProducts.forEach((p) => {
      if (p.externalId) {
        externalToProductIdMap.set(p.externalId, p.id);
      }
    });

    const reconciliationMap = new Map(reconciliations.map((r) => [r.product.externalId, r]));

    const departmentTotals: {
      [key: string]: {
        expectedQty: number;
        countedQty: number;
        expectedCost: number;
        countedCost: number;
      };
    } = {};

    // Process snapshot (expected)
    for (const snapshot of snapshotRecords) {
      const productId = externalToProductIdMap.get(snapshot.externalId);
      if (!productId) continue;

      const productInfo = productInfoMap.get(productId);
      const deptName = productInfo?.departmentName || "Unknown Department";

      if (!departmentTotals[deptName]) {
        departmentTotals[deptName] = {
          expectedQty: 0,
          countedQty: 0,
          expectedCost: 0,
          countedCost: 0,
        };
      }

      const itemCost = Number(
        productInfo?.baseCost ||
          (productInfo?.baseRetail ? Number(productInfo.baseRetail) * 0.5 : 0),
      );
      departmentTotals[deptName].expectedQty += snapshot.quantity;
      departmentTotals[deptName].expectedCost += snapshot.quantity * itemCost;
    }

    // Process physical counts, but prioritize reconciled data
    const allCountedExternalIds = new Set(
      [
        ...physicalCounts.map((p) => productInfoMap.get(p.productId)?.externalId),
        ...reconciliations.map((r) => r.product.externalId),
      ].filter((id): id is number => id !== null),
    );

    for (const externalId of allCountedExternalIds) {
      const productId = externalToProductIdMap.get(externalId);
      if (!productId) continue;

      const productInfo = productInfoMap.get(productId);
      const deptName = productInfo?.departmentName || "Unknown Department";

      if (!departmentTotals[deptName]) {
        departmentTotals[deptName] = {
          expectedQty: 0,
          countedQty: 0,
          expectedCost: 0,
          countedCost: 0,
        };
      }

      const reconciledData = reconciliationMap.get(externalId);
      const rawCount = physicalCounts
        .filter((p) => p.productId === productId)
        .reduce((sum, current) => sum + current.quantity, 0);

      const finalCount = reconciledData ? reconciledData.finalCount : rawCount;

      const itemCost = Number(
        productInfo?.baseCost ||
          (productInfo?.baseRetail ? Number(productInfo.baseRetail) * 0.5 : 0),
      );
      departmentTotals[deptName].countedQty += finalCount;
      departmentTotals[deptName].countedCost += finalCount * itemCost;
    }

    const finalReport = Object.entries(departmentTotals).map(([department, totals]) => ({
      department,
      ...totals,
      varianceQty: totals.countedQty - totals.expectedQty,
      varianceCost: totals.countedCost - totals.expectedCost,
    }));

    res.status(200).json(finalReport);
  } catch (error) {
    logError("Error fetching on-hand by department", error);
    res.status(500).json({ error: "Failed to fetch on-hand totals." });
  }
}
