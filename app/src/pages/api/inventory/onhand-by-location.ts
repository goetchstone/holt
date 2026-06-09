// /app/src/pages/api/inventory/onhand-by-location.ts

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
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  try {
    const [snapshotRecords, physicalCounts, reconciliations, allProducts, departments] =
      await Promise.all([
        prisma.inventorySnapshot.findMany({
          select: { externalId: true, quantity: true, stockLocation: true },
        }),
        prisma.physicalInventoryCount.findMany({
          select: { productId: true, quantity: true, stockLocation: true },
        }),
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

    const reconciliationMap = new Map(
      reconciliations.map((r) => [r.product.externalId + "-" + r.location, r]),
    );

    const locationTotals: {
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
      let locName = snapshot.stockLocation;

      if (locName === "Warehouse") {
        const deptName = productInfo?.departmentName;
        locName =
          deptName && APPAREL_DEPARTMENTS.includes(deptName)
            ? "Warehouse - Apparel"
            : "Warehouse - General";
      }

      if (!locationTotals[locName]) {
        locationTotals[locName] = {
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
      locationTotals[locName].expectedQty += snapshot.quantity;
      locationTotals[locName].expectedCost += snapshot.quantity * itemCost;
    }

    // Process physical counts and reconciliations
    const allCountedProducts = new Map<string, { productId: number; location: string }>();
    physicalCounts.forEach((p) =>
      allCountedProducts.set(p.productId + "-" + p.stockLocation, {
        productId: p.productId,
        location: p.stockLocation,
      }),
    );
    reconciliations.forEach((r) =>
      allCountedProducts.set(r.productId + "-" + r.location, {
        productId: r.productId,
        location: r.location,
      }),
    );

    for (const { productId, location } of allCountedProducts.values()) {
      const productInfo = productInfoMap.get(productId);
      if (!productInfo || !productInfo.externalId) continue;

      let locName = location;
      if (locName === "Warehouse") {
        const deptName = productInfo.departmentName;
        locName =
          deptName && APPAREL_DEPARTMENTS.includes(deptName)
            ? "Warehouse - Apparel"
            : "Warehouse - General";
      }
      if (!locationTotals[locName]) {
        locationTotals[locName] = {
          expectedQty: 0,
          countedQty: 0,
          expectedCost: 0,
          countedCost: 0,
        };
      }

      const reconciledData = reconciliationMap.get(productInfo.externalId + "-" + location);
      const rawCount = physicalCounts
        .filter((p) => p.productId === productId && p.stockLocation === location)
        .reduce((sum, current) => sum + current.quantity, 0);

      const finalCount = reconciledData ? reconciledData.finalCount : rawCount;

      const itemCost = Number(
        productInfo.baseCost || (productInfo.baseRetail ? Number(productInfo.baseRetail) * 0.5 : 0),
      );
      locationTotals[locName].countedQty += finalCount;
      locationTotals[locName].countedCost += finalCount * itemCost;
    }

    const finalReport = Object.entries(locationTotals).map(([location, totals]) => ({
      location,
      ...totals,
      varianceQty: totals.countedQty - totals.expectedQty,
      varianceCost: totals.countedCost - totals.expectedCost,
    }));

    res.status(200).json(finalReport);
  } catch (error) {
    logError("Error fetching on-hand by location", error);
    res.status(500).json({ error: "Failed to fetch on-hand totals." });
  }
}
