// /app/src/pages/api/inventory/summary-details.ts

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

  const { groupType, groupName } = req.query;

  if (
    !groupType ||
    !groupName ||
    typeof groupName !== "string" ||
    !["department", "location"].includes(groupType as string)
  ) {
    return res
      .status(400)
      .json({ error: "groupType (department or location) and groupName are required." });
  }

  try {
    let productWhereClause: Prisma.ProductWhereInput = {};
    let locationFilter = groupName; // Default location is the group name itself.

    if (groupType === "department") {
      productWhereClause = { department: { name: groupName } };
    } else if (groupType === "location") {
      // Handle the special compound warehouse location names
      if (groupName === "Warehouse - Apparel") {
        locationFilter = "Warehouse";
        productWhereClause = { department: { name: { in: APPAREL_DEPARTMENTS } } };
      } else if (groupName === "Warehouse - General") {
        locationFilter = "Warehouse";
        productWhereClause = { department: { name: { notIn: APPAREL_DEPARTMENTS } } };
      }

      // Find all products that have records in the specified location.
      const snapshotExternalIds = (
        await prisma.inventorySnapshot.findMany({
          where: { stockLocation: locationFilter },
          select: { externalId: true },
        })
      ).map((s) => s.externalId);

      const physicalCountProductIds = (
        await prisma.physicalInventoryCount.findMany({
          where: { stockLocation: locationFilter },
          select: { productId: true },
        })
      ).map((p) => p.productId);

      // Combine product IDs from both sources and add to the main where clause
      productWhereClause = {
        ...productWhereClause,
        OR: [{ externalId: { in: snapshotExternalIds } }, { id: { in: physicalCountProductIds } }],
      };
    }

    const products = await prisma.product.findMany({
      where: productWhereClause,
      select: {
        id: true,
        externalId: true,
        name: true,
        productNumber: true,
        baseCost: true,
        baseRetail: true,
      },
    });

    const productIds = products.map((p) => p.id);
    const externalIds = products.map((p) => p.externalId).filter((id): id is number => id !== null);

    const [snapshotCounts, physicalCounts] = await Promise.all([
      prisma.inventorySnapshot.findMany({
        where: {
          externalId: { in: externalIds },
          ...(groupType === "location" && { stockLocation: locationFilter }),
        },
      }),
      prisma.physicalInventoryCount.findMany({
        where: {
          productId: { in: productIds },
          ...(groupType === "location" && { stockLocation: locationFilter }),
        },
      }),
    ]);

    const productIdMap = new Map(products.map((p) => [p.id, p]));
    const externalIdMap = new Map(products.map((p) => [p.externalId, p]));

    const itemDetails: {
      [key: number]: {
        expectedQty: number;
        countedQty: number;
        expectedCost: number;
        countedCost: number;
      };
    } = {};

    snapshotCounts.forEach((s) => {
      const product = externalIdMap.get(s.externalId);
      if (!product) return;
      if (!itemDetails[product.id])
        itemDetails[product.id] = {
          expectedQty: 0,
          countedQty: 0,
          expectedCost: 0,
          countedCost: 0,
        };
      itemDetails[product.id].expectedQty += s.quantity;
      const itemCost = Number(
        product.baseCost || (product.baseRetail ? Number(product.baseRetail) * 0.5 : 0),
      );
      itemDetails[product.id].expectedCost += s.quantity * itemCost;
    });

    physicalCounts.forEach((p) => {
      const product = productIdMap.get(p.productId);
      if (!product) return;
      if (!itemDetails[product.id])
        itemDetails[product.id] = {
          expectedQty: 0,
          countedQty: 0,
          expectedCost: 0,
          countedCost: 0,
        };
      itemDetails[product.id].countedQty += p.quantity;
      const itemCost = Number(
        product.baseCost || (product.baseRetail ? Number(product.baseRetail) * 0.5 : 0),
      );
      itemDetails[product.id].countedCost += p.quantity * itemCost;
    });

    const report = Object.entries(itemDetails).map(([productId, totals]) => {
      const product = productIdMap.get(Number(productId));
      return {
        productId: Number(productId),
        externalId: product?.externalId,
        name: product?.name,
        productNumber: product?.productNumber,
        ...totals,
        varianceQty: totals.countedQty - totals.expectedQty,
        varianceCost: totals.countedCost - totals.expectedCost,
      };
    });

    res.status(200).json(report);
  } catch (error) {
    logError("Failed to fetch summary details", error);
    res.status(500).json({ error: "Failed to fetch summary details." });
  }
}
