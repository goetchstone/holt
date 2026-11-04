// /app/prisma/seed/demo/reorderPoints.ts
//
// Levels to keep (GAP-14), so Purchasing > Low Stock isn't an empty table. Taken
// from stock the demo already holds, with no random draw, so nothing else the
// seed makes shifts. Every third is set above what's free, so it reads as low.

import type { PrismaClient } from "@prisma/client";
import { freePositionWhere } from "@/lib/inventory/allocation";
import { toQty } from "@/lib/inventory/quantity";

const SEED_ACTOR = "seed:demo";
const HOW_MANY = 24;

export async function seedReorderPoints(prisma: PrismaClient): Promise<{ points: number }> {
  const stock = await prisma.inventoryPosition.groupBy({
    by: ["productId", "storeLocationId"],
    where: {
      ...freePositionWhere(),
      product: { isActive: true, isDiscontinued: false },
    },
    _sum: { quantity: true },
    orderBy: [{ productId: "asc" }, { storeLocationId: "asc" }],
    take: HOW_MANY,
  });
  let points = 0;
  for (const [i, row] of stock.entries()) {
    const free = Math.max(toQty(row._sum.quantity), 1);
    await prisma.reorderPoint.create({
      data: {
        productId: row.productId,
        storeLocationId: row.storeLocationId,
        minQuantity: i % 3 === 0 ? Math.ceil(free) + 2 : 1,
        orderQuantity: i % 6 === 0 ? 4 : null,
        createdBy: SEED_ACTOR,
      },
    });
    points += 1;
  }
  return { points };
}
