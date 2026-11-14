// /app/prisma/seed/demo/sales.ts
//
// GAP-06 part B: scheduled sales. The demo store has one sale that has ended, one
// on now and one coming up, each on a few products at a percent off their regular
// price. The names are invented.
//
// They are written through the code the Sales screen uses (lib/pricing/sales.ts
// createSale), so each has its SALE_SCHEDULED entry and passes the same checks: a
// sale price below the regular one, and no product in two sales on one day. Dates
// are the store's days around the seed's anchor date. No RNG draws: products are
// taken by position after the ones the markdown and the price lock use, and this
// runs last, so nothing else the seed makes shifts.

import type { PrismaClient } from "@prisma/client";
import { createSale } from "@/lib/pricing/sales";
import { planSalePrice } from "@/lib/pricing/salesShared";
import { addDays, businessDayKey } from "@/lib/reports/businessDay";
import { SEED_TIME_ZONE } from "./config";
import type { CatalogProduct } from "./catalog";

const SEED_ACTOR = "seed:demo";

/** Each demo sale: its name, its days relative to the anchor, its percent off. */
const DEMO_SALES = [
  { name: "Late Summer Clearance", from: -40, to: -26, percentOff: 25, note: "Floor models" },
  { name: "Harvest Weekend Event", from: -2, to: 9, percentOff: 15, note: null },
  { name: "Winter Comfort Preview", from: 18, to: 31, percentOff: 20, note: "Upholstery only" },
] as const;

/** How many products each sale carries. */
const PER_SALE = 4;
/** The first products are the markdown's four and the locked one (priceChanges.ts). */
const SKIP = 5;

export async function seedSales(
  prisma: PrismaClient,
  products: readonly CatalogProduct[],
  asOf: Date,
): Promise<{ sales: number; items: number }> {
  const priced = products.filter((p) => p.baseRetail > 0).slice(SKIP);
  const today = businessDayKey(asOf, SEED_TIME_ZONE);
  let items = 0;
  for (const [i, sale] of DEMO_SALES.entries()) {
    const chosen = priced.slice(i * PER_SALE, (i + 1) * PER_SALE);
    // Regular prices as they stand now, as the screen's preview would read them.
    const current = await prisma.product.findMany({
      where: { id: { in: chosen.map((p) => p.id) } },
      orderBy: { id: "asc" },
      select: { id: true, baseRetail: true },
    });
    const saleItems = current.flatMap((p) => {
      const plan = planSalePrice(
        p.baseRetail === null ? null : Number(p.baseRetail),
        { kind: "PERCENT_OFF", percent: sale.percentOff, rounding: "END_99" },
        "CENTS",
      );
      return plan.skipped || plan.salePrice === null
        ? []
        : [{ productId: p.id, salePrice: plan.salePrice }];
    });
    await createSale(
      {
        name: sale.name,
        startsOn: addDays(today, sale.from),
        endsOn: addDays(today, sale.to),
        note: sale.note,
      },
      saleItems,
      SEED_ACTOR,
    );
    items += saleItems.length;
  }
  return { sales: DEMO_SALES.length, items };
}
