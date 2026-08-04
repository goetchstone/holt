// /app/src/pages/api/inventory/product-variance/[externalId].ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { externalId } = req.query;
  if (!externalId || typeof externalId !== "string") {
    return res.status(400).json({ error: "Product ID is required." });
  }

  const id = Number.parseInt(externalId, 10);
  if (Number.isNaN(id)) {
    return res.status(400).json({ error: "Invalid Product ID." });
  }

  try {
    const product = await prisma.product.findUnique({ where: { externalId: id } });
    if (!product) {
      return res.status(404).json({ error: "Product not found." });
    }

    // InventorySnapshot is keyed on productId now, not this route's externalId
    // -- the lookup above already resolved externalId -> product.id, so the
    // URL contract (this route is still keyed by externalId) stays intact.
    const [snapshotCounts, physicalCounts] = await Promise.all([
      prisma.inventorySnapshot.findMany({
        where: { productId: product.id },
        select: { quantity: true, storeLocation: { select: { name: true } } },
      }),
      prisma.physicalInventoryCount.findMany({ where: { productId: product.id } }),
    ]);

    const locationData: { [key: string]: { expected: number; counted: number } } = {};

    snapshotCounts.forEach((s) => {
      const locName = s.storeLocation.name;
      if (!locationData[locName]) {
        locationData[locName] = { expected: 0, counted: 0 };
      }
      locationData[locName].expected += s.quantity;
    });

    physicalCounts.forEach((p) => {
      if (!locationData[p.stockLocation]) {
        locationData[p.stockLocation] = { expected: 0, counted: 0 };
      }
      locationData[p.stockLocation].counted += p.quantity;
    });

    const report = Object.entries(locationData)
      .map(([location, data]) => ({
        location,
        expected: data.expected,
        counted: data.counted,
        variance: data.counted - data.expected,
      }))
      .filter((row) => row.expected !== 0 || row.counted !== 0)
      .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));

    res.status(200).json({ product, report });
  } catch (error) {
    logError("Failed to generate product variance report", error);
    res.status(500).json({ error: "Failed to generate product variance report." });
  }
}
