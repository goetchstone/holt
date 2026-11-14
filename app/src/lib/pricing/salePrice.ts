// /app/src/lib/pricing/salePrice.ts
//
// THE one answer to "what does this product sell for today" (GAP-06 part B,
// DECISIONS 60). A product's regular price is Product.baseRetail; a scheduled
// sale (Sale + SaleItem) gives it a sale price over a run of the store's days.
// Nothing is written when a sale starts or ends: whether its price applies is
// decided here, at read time, from the store's business day (rule 42 -- every
// reader comes through here):
//
//   - GET /api/products and /api/products/find-by-identifier, which the
//     register, New Quote and the search price tag read;
//   - catalogListUnits (lib/sales/discountApproval.ts), the list price the
//     discount policy measures from and OrderLineItem.listPrice records;
//   - duplicateOrder (today's prices), and the service line a house call books
//     (pages/api/service/house-calls), through catalogListUnits;
//   - the product and sale tags (lib/labels/productTag.ts).
//
// A sale price applies while startsOn <= today <= endsOn and the sale has not
// been ended early, and only while it is below the product's regular price: a
// customer never pays more "on sale" than off it (the regular price can be cut
// after a sale is scheduled). "Today" is the store's day (AppSettings.timezone),
// never the browser's. Reports' retail value of stock stays on baseRetail.

import type { Prisma, PrismaClient } from "@prisma/client";
import { getAppSettings } from "@/lib/appSettings";
import { businessDayKey, dayKeyToDbDate, dbDateToDayKey } from "@/lib/reports/businessDay";

type Db = Prisma.TransactionClient | PrismaClient;
type MoneyLike = Prisma.Decimal | number | string | null | undefined;

/** A product's sale price today, from its sale. */
export interface ActiveSalePrice {
  saleId: number;
  saleName: string;
  salePrice: number;
  /** The sale's last day, "YYYY-MM-DD". */
  endsOn: string;
}

export interface EffectiveRetail {
  /** What the register charges today, or null when the product has no price. */
  price: number | null;
  /** Product.baseRetail: the price when no sale applies. Null when none. */
  regularPrice: number | null;
  onSale: boolean;
  /** The sale's last day ("YYYY-MM-DD") while on sale, else null. */
  saleEndsOn: string | null;
}

/** A positive price as a number, else null: 0 is no price (catalogRetailPrice). */
function positivePrice(value: MoneyLike): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * What a product sells for, given its regular price and the sale price that
 * covers today (or none). Pure. A sale price applies only below a regular
 * price: with no regular price, or one at or under the sale's, it is the
 * regular price.
 */
export function effectiveRetail(input: {
  baseRetail: MoneyLike;
  sale: { salePrice: MoneyLike; endsOn: string } | null | undefined;
}): EffectiveRetail {
  const regularPrice = positivePrice(input.baseRetail);
  const salePrice = input.sale ? positivePrice(input.sale.salePrice) : null;
  if (
    input.sale &&
    regularPrice !== null &&
    salePrice !== null &&
    Math.round(salePrice * 100) < Math.round(regularPrice * 100)
  ) {
    return { price: salePrice, regularPrice, onSale: true, saleEndsOn: input.sale.endsOn };
  }
  return { price: regularPrice, regularPrice, onSale: false, saleEndsOn: null };
}

/** Is a sale on, on `today`? Pure: started, not past its last day, not ended early. */
export function saleCoversDay(
  sale: { startsOn: Date | string; endsOn: Date | string; endedEarlyAt: Date | null },
  today: string,
): boolean {
  if (sale.endedEarlyAt !== null) return false;
  const day = (v: Date | string) => (v instanceof Date ? dbDateToDayKey(v)! : v.slice(0, 10));
  return day(sale.startsOn) <= today && today <= day(sale.endsOn);
}

/** Today on the store's clock, "YYYY-MM-DD": the day a sale price is decided for. */
export async function saleToday(now: Date = new Date()): Promise<string> {
  const { timezone } = await getAppSettings();
  return businessDayKey(now, timezone);
}

/**
 * The sale price that covers `today` for each of these products, by product id.
 * A product in no sale today is absent. Should two sales ever cover one product
 * on one day (the writer refuses it, lib/pricing/sales.ts), the lower price wins.
 */
export async function loadActiveSalePrices(
  productIds: readonly number[],
  today: string,
  db: Db,
): Promise<Map<number, ActiveSalePrice>> {
  const ids = [...new Set(productIds)];
  const found = new Map<number, ActiveSalePrice>();
  if (ids.length === 0) return found;
  const day = dayKeyToDbDate(today);
  const items = await db.saleItem.findMany({
    where: {
      productId: { in: ids },
      sale: { startsOn: { lte: day }, endsOn: { gte: day }, endedEarlyAt: null },
    },
    orderBy: [{ salePrice: "asc" }, { id: "asc" }],
    select: {
      productId: true,
      salePrice: true,
      sale: { select: { id: true, name: true, endsOn: true } },
    },
  });
  for (const item of items) {
    if (found.has(item.productId)) continue;
    found.set(item.productId, {
      saleId: item.sale.id,
      saleName: item.sale.name,
      salePrice: Number(item.salePrice),
      endsOn: dbDateToDayKey(item.sale.endsOn)!,
    });
  }
  return found;
}

/**
 * Each product's effective retail today, for rows that carry their own
 * baseRetail -- the shape a product list or lookup already has in hand.
 */
export async function effectiveRetailFor<T extends { id: number; baseRetail: MoneyLike }>(
  products: readonly T[],
  today: string,
  db: Db,
): Promise<Map<number, EffectiveRetail>> {
  const sales = await loadActiveSalePrices(
    products.map((p) => p.id),
    today,
    db,
  );
  return new Map(
    products.map((p) => [
      p.id,
      effectiveRetail({ baseRetail: p.baseRetail, sale: sales.get(p.id) }),
    ]),
  );
}

/**
 * The fields a product response carries for the screens: `baseRetail` is the
 * price the register charges today (what catalogRetailPrice reads), and
 * `regularRetail` the price off sale. A screen that edits the product writes
 * regularRetail back, never baseRetail (components/modals/ProductEditModal.tsx).
 */
export function retailResponseFields(e: EffectiveRetail): {
  baseRetail: number | undefined;
  regularRetail: number | null;
  onSale: boolean;
  saleEndsOn: string | null;
} {
  return {
    baseRetail: e.price ?? undefined,
    regularRetail: e.regularPrice,
    onSale: e.onSale,
    saleEndsOn: e.saleEndsOn,
  };
}
