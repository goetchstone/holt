// /app/src/lib/pricing/sales.ts
//
// Scheduled sales (GAP-06 part B, DECISIONS 60): the server side of
// /api/pricing/sales. The contract is salesShared.ts; whether a sale price
// applies on a day is salePrice.ts.
//
// ONE SALE PRICE PER PRODUCT PER DAY. Every write that sets a sale's products or
// dates locks those products' rows FOR UPDATE in id order (as the retail writer
// does) and only then looks for another sale carrying one of them on an
// overlapping day, refusing the write if it finds one. Two people scheduling
// the same product at once queue on the row lock; the second sees the first's
// item and is refused. No unique key can say this (a range overlap), and none
// is attempted over a nullable column (rule 64). A sale ended early no longer
// applies on any day a write may still set (a sale starts today or later), so
// it blocks nothing.
//
// Every change is audited in its own transaction: SALE_SCHEDULED, SALE_CHANGED,
// SALE_ENDED, SALE_DELETED (group "prices").

import { Prisma } from "@prisma/client";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { auditLog } from "@/lib/audit";
import type { PricingConfig } from "@/lib/appSettings";
import { getAppSettings } from "@/lib/appSettings";
import { moneyOrNull } from "@/lib/pricing/retailWriter";
import { effectiveRetail, loadActiveSalePrices } from "@/lib/pricing/salePrice";
import {
  addDays,
  businessDayStart,
  dayKeyToDbDate,
  dbDateToDayKey,
} from "@/lib/reports/businessDay";
import {
  deleteProblem,
  endEarlyProblem,
  isBelow,
  planSalePrice,
  saleChangeProblem,
  saleDatesProblem,
  saleStatus,
  type SaleFields,
  type SaleItemInput,
  type SalePatch,
  type SalePreviewRow,
  type SalePricing,
  type SaleDetail,
  type SaleStatus,
  type SaleSummary,
  type TagToChange,
  type TagsToChange,
} from "@/lib/pricing/salesShared";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

/** A sale write the caller got wrong (400), or one that no longer exists (404). */
export class SaleRefused extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "SaleRefused";
  }
}

interface SaleRow {
  id: number;
  name: string;
  startsOn: Date;
  endsOn: Date;
  note: string | null;
  createdBy: string;
  endedEarlyAt: Date | null;
  endedEarlyBy: string | null;
}

const dayOf = (d: Date) => dbDateToDayKey(d)!;

function summarize(sale: SaleRow, itemCount: number, today: string): SaleSummary {
  const startsOn = dayOf(sale.startsOn);
  const endsOn = dayOf(sale.endsOn);
  return {
    id: sale.id,
    name: sale.name,
    startsOn,
    endsOn,
    note: sale.note,
    status: saleStatus({ startsOn, endsOn, endedEarlyAt: sale.endedEarlyAt }, today),
    itemCount,
    createdBy: sale.createdBy,
    endedEarlyAt: sale.endedEarlyAt?.toISOString() ?? null,
    endedEarlyBy: sale.endedEarlyBy,
  };
}

/** Every sale, newest first, with where it stands today. */
export async function listSales(today: string): Promise<SaleSummary[]> {
  const sales = await prisma.sale.findMany({
    orderBy: [{ startsOn: "desc" }, { id: "desc" }],
    include: { _count: { select: { items: true } } },
  });
  return sales.map((s) => summarize(s, s._count.items, today));
}

/** One sale with its products, their regular price and their sale price. */
export async function getSale(id: number, today: string): Promise<SaleDetail> {
  const sale = await prisma.sale.findUnique({
    where: { id },
    include: {
      items: {
        orderBy: { productId: "asc" },
        select: {
          productId: true,
          salePrice: true,
          product: { select: { productNumber: true, name: true, baseRetail: true } },
        },
      },
    },
  });
  if (!sale) throw new SaleRefused("That sale doesn't exist.", 404);
  return {
    ...summarize(sale, sale.items.length, today),
    items: sale.items.map((i) => ({
      productId: i.productId,
      productNumber: i.product.productNumber,
      name: i.product.name,
      regularPrice: moneyOrNull(i.product.baseRetail),
      salePrice: Number(i.salePrice),
    })),
  };
}

/** Items of OTHER sales, not ended early, carrying these products on a day in startsOn..endsOn. */
async function overlappingItems(
  db: Db,
  productIds: readonly number[],
  startsOn: string,
  endsOn: string,
  excludeSaleId: number | null,
) {
  if (productIds.length === 0) return [];
  return db.saleItem.findMany({
    where: {
      productId: { in: [...productIds] },
      sale: {
        endedEarlyAt: null,
        startsOn: { lte: dayKeyToDbDate(endsOn) },
        endsOn: { gte: dayKeyToDbDate(startsOn) },
        ...(excludeSaleId !== null && { id: { not: excludeSaleId } }),
      },
    },
    orderBy: [{ productId: "asc" }, { saleId: "asc" }],
    select: { productId: true, sale: { select: { id: true, name: true } } },
  });
}

/**
 * Each selected product's sale price, or why it is left out. Writes nothing;
 * save sends the priced rows back and checks them again under the row lock.
 */
export async function previewSaleItems(input: {
  productIds: readonly number[];
  pricing: SalePricing;
  startsOn: string;
  endsOn: string;
  excludeSaleId: number | null;
  pricingConfig: PricingConfig;
}): Promise<SalePreviewRow[]> {
  const products = await prisma.product.findMany({
    where: { id: { in: [...input.productIds] } },
    orderBy: { id: "asc" },
    select: { id: true, productNumber: true, name: true, baseRetail: true },
  });
  const overlaps = new Map<number, { id: number; name: string }>();
  for (const item of await overlappingItems(
    prisma,
    products.map((p) => p.id),
    input.startsOn,
    input.endsOn,
    input.excludeSaleId,
  )) {
    if (!overlaps.has(item.productId)) overlaps.set(item.productId, item.sale);
  }
  return products.map((p) => {
    const regularPrice = moneyOrNull(p.baseRetail);
    const plan = planSalePrice(
      regularPrice !== null && regularPrice > 0 ? regularPrice : null,
      input.pricing,
      input.pricingConfig.retailRounding,
    );
    const overlap = overlaps.get(p.id) ?? null;
    return {
      productId: p.id,
      productNumber: p.productNumber,
      name: p.name,
      regularPrice,
      salePrice: plan.salePrice,
      skipped: plan.skipped ?? (overlap ? "OVERLAPS" : null),
      overlaps: overlap,
    };
  });
}

interface LockedProduct {
  id: number;
  name: string;
  baseRetail: Prisma.Decimal | null;
}

/**
 * Check a sale's items against its dates and write them, replacing what it
 * had, inside the caller's transaction. The products are locked FOR UPDATE in
 * id order first, so the overlap check can't race another sale's write.
 */
async function writeItems(
  tx: Tx,
  saleId: number,
  dates: { startsOn: string; endsOn: string },
  items: readonly SaleItemInput[],
): Promise<void> {
  const ids = items.map((i) => i.productId).sort((a, b) => a - b);
  const rows =
    ids.length === 0
      ? []
      : await tx.$queryRaw<LockedProduct[]>`
          SELECT id, name, "baseRetail"
          FROM "Product"
          WHERE id = ANY(${ids}::int[])
          ORDER BY id
          FOR UPDATE`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const item of items) {
    const product = byId.get(item.productId);
    if (!product) throw new SaleRefused(`Product ${item.productId} doesn't exist.`);
    const regular = moneyOrNull(product.baseRetail);
    if (regular === null || regular <= 0) {
      throw new SaleRefused(`${product.name} has no regular price to take a sale price from.`);
    }
    if (!isBelow(item.salePrice, regular)) {
      throw new SaleRefused(
        `${product.name}: the sale price ${item.salePrice.toFixed(2)} must be below its regular price ${regular.toFixed(2)}. Preview again.`,
      );
    }
  }
  const clash = await overlappingItems(tx, ids, dates.startsOn, dates.endsOn, saleId);
  if (clash.length > 0) {
    const first = clash[0];
    const name = byId.get(first.productId)?.name ?? `Product ${first.productId}`;
    const more = clash.length > 1 ? ` (and ${clash.length - 1} more)` : "";
    throw new SaleRefused(
      `${name} is already in the sale "${first.sale.name}" on some of these days${more}. A product has one sale price a day.`,
    );
  }
  await tx.saleItem.deleteMany({ where: { saleId } });
  if (items.length > 0) {
    await tx.saleItem.createMany({
      data: items.map((i) => ({ saleId, productId: i.productId, salePrice: i.salePrice })),
    });
  }
}

const range = (startsOn: string, endsOn: string) =>
  startsOn === endsOn ? startsOn : `${startsOn} to ${endsOn}`;
const products = (n: number) => `${n} ${n === 1 ? "product" : "products"}`;

/** Schedule a sale and its products in one transaction. */
export async function createSale(
  fields: SaleFields,
  items: readonly SaleItemInput[],
  actor: string,
): Promise<{ id: number }> {
  return prisma.$transaction(async (tx) => {
    const sale = await tx.sale.create({
      data: {
        name: fields.name,
        startsOn: dayKeyToDbDate(fields.startsOn),
        endsOn: dayKeyToDbDate(fields.endsOn),
        note: fields.note,
        createdBy: actor,
      },
      select: { id: true },
    });
    await writeItems(tx, sale.id, fields, items);
    await auditLog(
      "SALE_SCHEDULED",
      actor,
      {
        summary: `Sale "${fields.name}" scheduled for ${range(fields.startsOn, fields.endsOn)}: ${products(items.length)}`,
        target: { type: "sale", id: sale.id },
        details: { startsOn: fields.startsOn, endsOn: fields.endsOn, items: items.length },
      },
      tx,
    );
    return sale;
  }, TX_TIMEOUT.LONG);
}

/** The sale's row, locked so two changes to it run one after the other. */
async function lockSale(tx: Tx, id: number): Promise<SaleRow> {
  const [row] = await tx.$queryRaw<SaleRow[]>`
    SELECT id, name, "startsOn", "endsOn", note, "createdBy", "endedEarlyAt", "endedEarlyBy"
    FROM "Sale" WHERE id = ${id} FOR UPDATE`;
  if (!row) throw new SaleRefused("That sale doesn't exist.", 404);
  return row;
}

function statusOf(sale: SaleRow, today: string): SaleStatus {
  return saleStatus(
    { startsOn: dayOf(sale.startsOn), endsOn: dayOf(sale.endsOn), endedEarlyAt: sale.endedEarlyAt },
    today,
  );
}

/** The name and note a patch changes, and their names for the record. */
function labelChanges(
  sale: SaleRow,
  patch: SalePatch,
): { data: Prisma.SaleUpdateInput; changed: string[] } {
  const data: Prisma.SaleUpdateInput = {};
  const changed: string[] = [];
  if (patch.name !== undefined && patch.name !== sale.name) {
    data.name = patch.name;
    changed.push("name");
  }
  if (patch.note !== undefined && patch.note !== sale.note) {
    data.note = patch.note;
    changed.push("note");
  }
  return { data, changed };
}

/**
 * Change a sale: name and note at any time; dates and products only before it
 * starts (salesShared.ts saleChangeProblem). New dates re-check every product
 * the sale carries for overlap, under the row lock.
 */
export async function updateSale(
  id: number,
  patch: SalePatch,
  actor: string,
  today: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const sale = await lockSale(tx, id);
    const problem = saleChangeProblem(statusOf(sale, today), patch);
    if (problem) throw new SaleRefused(problem);
    const { data, changed } = labelChanges(sale, patch);
    const dates = {
      startsOn: patch.startsOn ?? dayOf(sale.startsOn),
      endsOn: patch.endsOn ?? dayOf(sale.endsOn),
    };
    const datesMove =
      dates.startsOn !== dayOf(sale.startsOn) || dates.endsOn !== dayOf(sale.endsOn);
    if (datesMove) {
      const datesProblem = saleDatesProblem(dates.startsOn, dates.endsOn, today);
      if (datesProblem) throw new SaleRefused(datesProblem);
      data.startsOn = dayKeyToDbDate(dates.startsOn);
      data.endsOn = dayKeyToDbDate(dates.endsOn);
      changed.push("dates");
    }
    let items = patch.items;
    if (items !== undefined) changed.push("products");
    // New dates are checked against every product the sale keeps.
    if (datesMove && items === undefined) {
      items = (
        await tx.saleItem.findMany({
          where: { saleId: id },
          select: { productId: true, salePrice: true },
        })
      ).map((i) => ({ productId: i.productId, salePrice: Number(i.salePrice) }));
    }
    if (changed.length === 0) return;
    if (Object.keys(data).length > 0) await tx.sale.update({ where: { id }, data });
    if (items !== undefined) await writeItems(tx, id, dates, items);
    await auditLog(
      "SALE_CHANGED",
      actor,
      {
        summary: `Sale "${patch.name ?? sale.name}" changed: ${changed.join(", ")}`,
        target: { type: "sale", id },
        details: {
          changed,
          ...(datesMove && { startsOn: dates.startsOn, endsOn: dates.endsOn }),
          ...(patch.items !== undefined && { items: patch.items.length }),
        },
      },
      tx,
    );
  }, TX_TIMEOUT.LONG);
}

/** End a sale that is on, now. Its rows stay as the record of what was charged. */
export async function endSaleEarly(id: number, actor: string, today: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const sale = await lockSale(tx, id);
    const problem = endEarlyProblem(statusOf(sale, today));
    if (problem) throw new SaleRefused(problem);
    await tx.sale.update({
      where: { id },
      data: { endedEarlyAt: new Date(), endedEarlyBy: actor },
    });
    await auditLog(
      "SALE_ENDED",
      actor,
      {
        summary: `Sale "${sale.name}" ended early (it was to run to ${dayOf(sale.endsOn)})`,
        target: { type: "sale", id },
        details: { endsOn: dayOf(sale.endsOn), endedOn: today },
      },
      tx,
    );
  });
}

/** Delete a sale that hasn't started, and its products. */
export async function deleteSale(id: number, actor: string, today: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const sale = await lockSale(tx, id);
    const problem = deleteProblem(statusOf(sale, today));
    if (problem) throw new SaleRefused(problem);
    const items = await tx.saleItem.count({ where: { saleId: id } });
    await tx.sale.delete({ where: { id } });
    await auditLog(
      "SALE_DELETED",
      actor,
      {
        summary: `Sale "${sale.name}" deleted before it started (${range(dayOf(sale.startsOn), dayOf(sale.endsOn))}, ${products(items)})`,
        target: { type: "sale", id },
        details: { startsOn: dayOf(sale.startsOn), endsOn: dayOf(sale.endsOn), items },
      },
      tx,
    );
  });
}

/**
 * The products whose tag must change today: those in a sale that starts today
 * (a SALE tag), and those in a sale that ended yesterday or was ended early
 * since the start of yesterday (back to a PRODUCT tag). Each product is listed
 * once, by what it sells for now: one whose old sale ended but which is on
 * sale again today needs the new sale's tag. Nothing is printed or written here.
 */
export async function tagsToChange(today: string): Promise<TagsToChange> {
  const { timezone } = await getAppSettings();
  const yesterday = addDays(today, -1);
  const select = {
    productId: true,
    product: { select: { productNumber: true, name: true, baseRetail: true } },
    sale: { select: { name: true } },
  } as const;
  const [starting, ended] = await Promise.all([
    prisma.saleItem.findMany({
      where: { sale: { startsOn: dayKeyToDbDate(today), endedEarlyAt: null } },
      select,
      orderBy: { productId: "asc" },
    }),
    prisma.saleItem.findMany({
      where: {
        sale: {
          OR: [
            { endsOn: dayKeyToDbDate(yesterday), endedEarlyAt: null },
            { endedEarlyAt: { gte: businessDayStart(yesterday, timezone) } },
          ],
        },
      },
      select,
      orderBy: { productId: "asc" },
    }),
  ]);
  const productsById = new Map(
    [...starting, ...ended].map((i) => [i.productId, i.product] as const),
  );
  const ids = [...productsById.keys()].sort((a, b) => a - b);
  const sales = await loadActiveSalePrices(ids, today, prisma);
  const endedSale = new Map(ended.map((i) => [i.productId, i.sale.name]));
  const saleTags: TagToChange[] = [];
  const productTags: TagToChange[] = [];
  for (const productId of ids) {
    const product = productsById.get(productId)!;
    const sale = sales.get(productId);
    const price = effectiveRetail({ baseRetail: product.baseRetail, sale });
    const tag = (saleName: string): TagToChange => ({
      productId,
      productNumber: product.productNumber,
      name: product.name,
      price: price.price,
      regularPrice: price.regularPrice,
      saleName,
      saleEndsOn: price.saleEndsOn,
    });
    if (price.onSale) saleTags.push(tag(sale!.saleName));
    // Off sale today after a sale that ended: back to its regular tag. A product
    // only starting a sale that doesn't apply (its regular price has fallen to
    // the sale's or below) keeps the tag it has.
    else if (endedSale.has(productId)) productTags.push(tag(endedSale.get(productId)!));
  }
  return { today, saleTags, productTags };
}
