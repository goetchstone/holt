// /app/src/pages/api/inventory/freeze/compare.ts

import { NextApiRequest, NextApiResponse } from "next";
import { Session } from "next-auth";
import { requireAuth } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

export default requireAuth(handleGet);

async function handleGet(req: NextApiRequest, res: NextApiResponse, _session: Session) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const freezeId1 = Number(req.query.freezeId1);
  const freezeId2 = Number(req.query.freezeId2);

  if (Number.isNaN(freezeId1) || Number.isNaN(freezeId2)) {
    return res.status(400).json({ error: "Both freezeId1 and freezeId2 are required" });
  }

  if (freezeId1 === freezeId2) {
    return res.status(400).json({ error: "Cannot compare a freeze with itself" });
  }

  const [freeze1, freeze2] = await Promise.all([
    prisma.inventoryFreeze.findUnique({
      where: { id: freezeId1 },
      include: {
        items: {
          include: {
            product: { select: { name: true, productNumber: true } },
            storeLocation: { select: { name: true, code: true } },
          },
        },
      },
    }),
    prisma.inventoryFreeze.findUnique({
      where: { id: freezeId2 },
      include: {
        items: {
          include: {
            product: { select: { name: true, productNumber: true } },
            storeLocation: { select: { name: true, code: true } },
          },
        },
      },
    }),
  ]);

  if (!freeze1 || !freeze2) {
    return res.status(404).json({ error: "One or both freezes not found" });
  }

  // Build lookup maps keyed by productId-storeLocationId
  const buildMap = (items: typeof freeze1.items) => {
    const map = new Map<string, (typeof items)[0]>();
    for (const item of items) {
      const key = `${item.productId}-${item.storeLocationId ?? "null"}`;
      map.set(key, item);
    }
    return map;
  };

  const map1 = buildMap(freeze1.items);
  const map2 = buildMap(freeze2.items);

  const allKeys = new Set([...map1.keys(), ...map2.keys()]);

  interface DiffItem {
    productId: number;
    productName: string;
    productNumber: string;
    storeLocationCode: string | null;
    storeLocationName: string | null;
    quantity1: number;
    quantity2: number;
    difference: number;
  }

  const differences: DiffItem[] = [];

  for (const key of allKeys) {
    const item1 = map1.get(key);
    const item2 = map2.get(key);
    const qty1 = item1?.quantity ?? 0;
    const qty2 = item2?.quantity ?? 0;

    if (qty1 !== qty2) {
      const ref = item1 || item2!;
      differences.push({
        productId: ref.productId,
        productName: ref.product.name,
        productNumber: ref.product.productNumber,
        storeLocationCode: ref.storeLocation?.code ?? null,
        storeLocationName: ref.storeLocation?.name ?? null,
        quantity1: qty1,
        quantity2: qty2,
        difference: qty2 - qty1,
      });
    }
  }

  // Sort by absolute difference descending
  differences.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));

  return res.json({
    freeze1: {
      id: freeze1.id,
      freezeDate: freeze1.freezeDate,
      description: freeze1.description,
    },
    freeze2: {
      id: freeze2.id,
      freezeDate: freeze2.freezeDate,
      description: freeze2.description,
    },
    differences,
    totalDifferences: differences.length,
  });
}
