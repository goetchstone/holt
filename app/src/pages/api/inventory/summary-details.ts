// /app/src/pages/api/inventory/summary-details.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";
import { resolveStoreLocationId } from "@/lib/storeLocationResolver";

const APPAREL_DEPARTMENTS = ["Accessories", "Mens Apparel", "Womens Apparel"];

interface LocationGroupFilter {
  productWhereClause: Prisma.ProductWhereInput;
  locationFilter: string;
  storeLocationId: number | null;
}

/**
 * Resolve a "location" group (including the two synthetic Warehouse-Apparel /
 * Warehouse-General splits) to a Product filter. Split out of the handler
 * purely to keep the handler's branching within the repo's cognitive-
 * complexity budget -- the two data sources it reads (InventorySnapshot,
 * PhysicalInventoryCount) mean this can't be a one-liner.
 */
async function buildLocationGroupFilter(groupName: string): Promise<LocationGroupFilter> {
  let productWhereClause: Prisma.ProductWhereInput = {};
  let locationFilter = groupName;

  // Handle the special compound warehouse location names
  if (groupName === "Warehouse - Apparel") {
    locationFilter = "Warehouse";
    productWhereClause = { department: { name: { in: APPAREL_DEPARTMENTS } } };
  } else if (groupName === "Warehouse - General") {
    locationFilter = "Warehouse";
    productWhereClause = { department: { name: { notIn: APPAREL_DEPARTMENTS } } };
  }

  // InventorySnapshot's counting grain is storeLocationId (see its schema
  // comment), not the free-text PhysicalInventoryCount.stockLocation string
  // this page's location groups use.
  const storeLocationId = await resolveStoreLocationId(locationFilter);

  // Find all products that have records in the specified location. Keyed on
  // productId, not externalId -- externalId is null for every product
  // created natively in holt, which used to make this filter silently drop
  // them from the group entirely.
  const snapshotProductIds = storeLocationId
    ? (
        await prisma.inventorySnapshot.findMany({
          where: { storeLocationId },
          select: { productId: true },
        })
      ).map((s) => s.productId)
    : [];

  const physicalCountProductIds = (
    await prisma.physicalInventoryCount.findMany({
      where: { stockLocation: locationFilter },
      select: { productId: true },
    })
  ).map((p) => p.productId);

  return {
    productWhereClause: {
      ...productWhereClause,
      OR: [{ id: { in: snapshotProductIds } }, { id: { in: physicalCountProductIds } }],
    },
    locationFilter,
    storeLocationId,
  };
}

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
    // InventorySnapshot's counting grain is storeLocationId (see its schema
    // comment) -- resolved by buildLocationGroupFilter and reused below
    // wherever this branch needs to filter InventorySnapshot.
    let storeLocationId: number | null = null;

    if (groupType === "department") {
      productWhereClause = { department: { name: groupName } };
    } else if (groupType === "location") {
      const locationGroup = await buildLocationGroupFilter(groupName);
      productWhereClause = locationGroup.productWhereClause;
      locationFilter = locationGroup.locationFilter;
      storeLocationId = locationGroup.storeLocationId;
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

    const [snapshotCounts, physicalCounts] = await Promise.all([
      groupType === "location" && !storeLocationId
        ? Promise.resolve([])
        : prisma.inventorySnapshot.findMany({
            where: {
              productId: { in: productIds },
              ...(groupType === "location" ? { storeLocationId: storeLocationId! } : {}),
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

    const itemDetails: {
      [key: number]: {
        expectedQty: number;
        countedQty: number;
        expectedCost: number;
        countedCost: number;
      };
    } = {};

    snapshotCounts.forEach((s) => {
      const product = productIdMap.get(s.productId);
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
