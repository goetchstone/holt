// /app/src/lib/purchasing/productSources.ts
//
// GAP-22: the other vendors an item can be bought from, set on the product
// screen (docs/DECISIONS.md 31). What a PO may order from which vendor is
// buyingTerms (productSourcesShared.ts); this file only keeps the list.
//
// Cost follows "View cost" (lib/auth/costVisibility.ts): strip, never deny.
// Anyone who edits the catalog may add a vendor and its item number; only a
// holder of View cost sets or sees what that vendor charges.

import { Prisma, type PrismaClient } from "@prisma/client";
import { ITEM_NUMBER_MAX, type ProductSourceRow } from "@/lib/purchasing/productSourcesShared";

export class ProductSourceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "ProductSourceError";
  }
}

type Db = Pick<PrismaClient, "product" | "vendor" | "productSource">;

interface Who {
  canSetCost: boolean;
  by: string | null;
}

const ROW = {
  id: true,
  vendorId: true,
  itemNumber: true,
  cost: true,
  vendor: { select: { name: true } },
} as const;

type Stored = Prisma.ProductSourceGetPayload<{ select: typeof ROW }>;

function toRow(s: Stored, showCost: boolean): ProductSourceRow {
  return {
    id: s.id,
    vendorId: s.vendorId,
    vendorName: s.vendor.name,
    itemNumber: s.itemNumber,
    ...(showCost ? { cost: s.cost === null ? null : Number(s.cost) } : {}),
  };
}

async function productOrThrow(db: Db, productId: number) {
  const product = await db.product.findUnique({
    where: { id: productId },
    select: { id: true, vendorId: true },
  });
  if (!product) throw new ProductSourceError("Product not found.", 404);
  return product;
}

function readItemNumber(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ProductSourceError("The item number must be text.");
  const trimmed = value.trim();
  if (trimmed.length > ITEM_NUMBER_MAX) {
    throw new ProductSourceError(`The item number is at most ${ITEM_NUMBER_MAX} characters.`);
  }
  return trimmed || null;
}

function readCost(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ProductSourceError("The cost must be an amount of zero or more.");
  }
  return value;
}

/** An item's other vendors, by vendor name. */
export async function listProductSources(
  db: Db,
  productId: number,
  showCost: boolean,
): Promise<ProductSourceRow[]> {
  await productOrThrow(db, productId);
  const sources = await db.productSource.findMany({
    where: { productId },
    orderBy: [{ vendor: { name: "asc" } }, { id: "asc" }],
    select: ROW,
  });
  return sources.map((s) => toRow(s, showCost));
}

/** Add a vendor the item can also be bought from. */
export async function addProductSource(
  db: Db,
  productId: number,
  body: Record<string, unknown>,
  who: Who,
): Promise<ProductSourceRow> {
  const product = await productOrThrow(db, productId);
  const vendorId = body.vendorId;
  if (typeof vendorId !== "number" || !Number.isInteger(vendorId)) {
    throw new ProductSourceError("Choose a vendor.");
  }
  const vendor = await db.vendor.findUnique({ where: { id: vendorId }, select: { name: true } });
  if (!vendor) throw new ProductSourceError("That vendor doesn't exist.");
  if (vendorId === product.vendorId) {
    throw new ProductSourceError(`${vendor.name} is this item's own vendor already.`, 409);
  }
  const itemNumber = readItemNumber(body.itemNumber);
  const cost = who.canSetCost ? readCost(body.cost) : null;
  try {
    const created = await db.productSource.create({
      data: { productId, vendorId, itemNumber, cost, createdBy: who.by },
      select: ROW,
    });
    return toRow(created, who.canSetCost);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new ProductSourceError(`${vendor.name} is already one of this item's vendors.`, 409);
    }
    throw err;
  }
}

/** Change another vendor's item number, or its cost (View cost only). */
export async function updateProductSource(
  db: Db,
  productId: number,
  sourceId: number,
  body: Record<string, unknown>,
  who: Who,
): Promise<ProductSourceRow> {
  const source = await db.productSource.findFirst({
    where: { id: sourceId, productId },
    select: { id: true },
  });
  if (!source) throw new ProductSourceError("That vendor isn't on this item.", 404);
  const data: Prisma.ProductSourceUpdateInput = { updatedBy: who.by };
  if ("itemNumber" in body) data.itemNumber = readItemNumber(body.itemNumber);
  if (who.canSetCost && "cost" in body) data.cost = readCost(body.cost);
  const updated = await db.productSource.update({
    where: { id: source.id },
    data,
    select: ROW,
  });
  return toRow(updated, who.canSetCost);
}

/** Stop buying the item from that vendor. POs already written keep their lines. */
export async function removeProductSource(
  db: Db,
  productId: number,
  sourceId: number,
): Promise<void> {
  const { count } = await db.productSource.deleteMany({ where: { id: sourceId, productId } });
  if (count === 0) throw new ProductSourceError("That vendor isn't on this item.", 404);
}
