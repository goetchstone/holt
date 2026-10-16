// /app/src/app/(dashboard)/app/reports/stock-by/page.tsx
//
// Stock and space: what is inside a store or a place, grouped by the places in
// it, place type or a product field, with each group's share of the measured
// floor (lib/reports/stockBy.ts). The server page gates and loads the stores
// and their places for the picker, plus the first answer (every store); the
// view asks /api/reports/stock-by for the rest.

import { prisma } from "@/lib/prisma";
import { requirePage } from "@/lib/auth/requirePage";
import { getStockBy, STOCK_BY_FIELDS } from "@/lib/reports/stockBy";
import { StockByView } from "./StockByView";

export default async function StockByPage() {
  await requirePage(undefined, { permission: "reporting.read" });
  const [stores, first] = await Promise.all([
    prisma.storeLocation.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        stockLocations: {
          where: { isActive: true },
          select: { id: true, code: true, name: true, parentId: true, sortOrder: true },
        },
      },
    }),
    getStockBy(prisma, {}, "place"),
  ]);
  return <StockByView stores={stores} fields={STOCK_BY_FIELDS} initial={first} />;
}
