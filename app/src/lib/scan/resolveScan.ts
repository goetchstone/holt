// /app/src/lib/scan/resolveScan.ts
//
// What a scan is (ledger plan phase 15). Holt's own labels first -- a place
// label `L-<id>`, a box label `B-<productId>-<box>-<of>` (scanCodes.ts) --
// then, as the text scanned:
//
//   1. a UPC (Upc.upc, any case);
//   2. a consignment rug's barcode (ConsignmentItem.barcode);
//   3. a product number (Product.productNumber, any case);
//   4. a place's own code at the store the scanner is working in.
//
// One resolver for every handheld page and the lookup API, so a code means
// the same thing wherever it is scanned (rule 42).

import type { Prisma, PrismaClient } from "@prisma/client";
import { LOCATION_TYPE_INFO, isStockLocationType } from "@/lib/inventory/locationTypes";
import { placePath } from "@/lib/inventory/placeTree";
import { cleanScan, parseScanCode } from "./scanCodes";

type Db = PrismaClient | Prisma.TransactionClient;

export interface ScannedPlace {
  id: number;
  code: string;
  name: string;
  locationType: string;
  storeLocationId: number;
  storeName: string;
  /** "North Barn › Floor 2 › Stock Sofas" */
  path: string;
  holdsStock: boolean;
  isActive: boolean;
}

export interface ScannedProduct {
  id: number;
  productNumber: string;
  name: string;
  /** Boxes one unit ships in; 1 when not set. */
  boxesPerUnit: number;
}

export type ScanResult =
  | { kind: "place"; code: string; place: ScannedPlace }
  | {
      kind: "product";
      code: string;
      via: "box" | "upc" | "consignment" | "productNumber";
      product: ScannedProduct;
      /** Set when a box label was scanned. */
      box: { box: number; of: number } | null;
      consignmentItemId: number | null;
    }
  | { kind: "unknown"; code: string; message: string };

const PRODUCT_SELECT = {
  id: true,
  productNumber: true,
  name: true,
  boxesPerUnit: true,
} as const;

function productOf(p: {
  id: number;
  productNumber: string;
  name: string;
  boxesPerUnit: number | null;
}): ScannedProduct {
  return { ...p, boxesPerUnit: Math.max(1, p.boxesPerUnit ?? 1) };
}

/** A place as a scan shows it: its store and its path in the store's tree. */
export async function scannedPlace(db: Db, placeId: number): Promise<ScannedPlace | null> {
  const place = await db.stockLocation.findUnique({
    where: { id: placeId },
    select: {
      id: true,
      code: true,
      name: true,
      locationType: true,
      isActive: true,
      storeLocationId: true,
      storeLocation: { select: { name: true } },
    },
  });
  if (!place) return null;
  const tree = await db.stockLocation.findMany({
    where: { storeLocationId: place.storeLocationId },
    select: { id: true, parentId: true, name: true },
  });
  return {
    id: place.id,
    code: place.code,
    name: place.name,
    locationType: place.locationType,
    storeLocationId: place.storeLocationId,
    storeName: place.storeLocation.name,
    path: placePath(tree, place.id),
    holdsStock: isStockLocationType(place.locationType)
      ? LOCATION_TYPE_INFO[place.locationType].holdsStock
      : true,
    isActive: place.isActive,
  };
}

export async function resolveScan(
  db: Db,
  raw: string,
  context: { storeLocationId?: number | null } = {},
): Promise<ScanResult> {
  const code = cleanScan(raw);
  if (!code) return { kind: "unknown", code, message: "Nothing was scanned." };
  const parsed = parseScanCode(code);

  if (parsed.kind === "place") {
    const place = await scannedPlace(db, parsed.placeId);
    return place
      ? { kind: "place", code, place }
      : { kind: "unknown", code, message: `No place has the label ${code}.` };
  }

  if (parsed.kind === "box") {
    const product = await db.product.findUnique({
      where: { id: parsed.productId },
      select: PRODUCT_SELECT,
    });
    if (!product)
      return { kind: "unknown", code, message: `No product has the box label ${code}.` };
    return {
      kind: "product",
      code,
      via: "box",
      product: productOf(product),
      box: { box: parsed.box, of: parsed.of },
      consignmentItemId: null,
    };
  }

  const upc = await db.upc.findFirst({
    where: { upc: { equals: code, mode: "insensitive" } },
    select: { product: { select: PRODUCT_SELECT } },
    orderBy: { sortOrder: "asc" },
  });
  if (upc?.product) {
    return {
      kind: "product",
      code,
      via: "upc",
      product: productOf(upc.product),
      box: null,
      consignmentItemId: null,
    };
  }

  const rug = await db.consignmentItem.findUnique({
    where: { barcode: code },
    select: { id: true, product: { select: PRODUCT_SELECT } },
  });
  if (rug?.product) {
    return {
      kind: "product",
      code,
      via: "consignment",
      product: productOf(rug.product),
      box: null,
      consignmentItemId: rug.id,
    };
  }

  const byNumber = await db.product.findFirst({
    where: { productNumber: { equals: code, mode: "insensitive" } },
    select: PRODUCT_SELECT,
  });
  if (byNumber) {
    return {
      kind: "product",
      code,
      via: "productNumber",
      product: productOf(byNumber),
      box: null,
      consignmentItemId: null,
    };
  }

  if (context.storeLocationId) {
    const own = await db.stockLocation.findFirst({
      where: {
        storeLocationId: context.storeLocationId,
        code: { equals: code, mode: "insensitive" },
      },
      select: { id: true },
    });
    if (own) {
      const place = await scannedPlace(db, own.id);
      if (place) return { kind: "place", code, place };
    }
  }

  return {
    kind: "unknown",
    code,
    message: rug
      ? `${code} is a consignment rug with no product in the catalog.`
      : `Nothing in Holt has the code ${code}.`,
  };
}
