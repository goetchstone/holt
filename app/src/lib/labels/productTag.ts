// /app/src/lib/labels/productTag.ts
//
// What goes on a product's tags (GAP-18): the price tag, the sale tag and the law
// tag. A template's context decides which fields it gets, so a tag printed from
// any path means the same thing.
//
// THE PRICE. Every tag prints what the register charges today (DECISIONS 43),
// read through lib/pricing/salePrice.ts: while a product's scheduled sale is on
// (GAP-06 part B), that is its sale price, on a price tag as on a sale tag.
//
// THE SALE TAG. During a scheduled sale it prints the sale price, the regular
// retail as the "was" price, and the sale's last day (saleEnds). With no sale on,
// it is a markdown as before: the product's retail, with Product.wasPrice -- the
// price it started at -- as the "was" price, and saleEnds blank.
//
// THE LAW TAG. What the law asks a tag to say depends on where the store is, so
// the wording is the store's template (rule 61), and the product supplies its own
// part: what it's made of, as lawTagText.
//
// A tag a product can't have is refused with the reason, not printed half empty.

import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/appSettings";
import {
  effectiveRetail,
  loadActiveSalePrices,
  type EffectiveRetail,
} from "@/lib/pricing/salePrice";
import { businessDayKey } from "@/lib/reports/businessDay";
import { saleDayText } from "@/lib/pricing/salesShared";
import { costCode } from "./costCode";
import { photoField } from "./photo";
import { renderTemplate } from "./renderTemplate";

/** Something the store or the product needs before this label can print. */
export class LabelSetupError extends Error {}

export const PRODUCT_TAG_KINDS = ["PRODUCT", "SALE", "LAW"] as const;
export type ProductTagKind = (typeof PRODUCT_TAG_KINDS)[number];

export function isProductTagKind(value: unknown): value is ProductTagKind {
  return typeof value === "string" && (PRODUCT_TAG_KINDS as readonly string[]).includes(value);
}

/** Largest number of one tag in a single print. */
export const MAX_TAG_COPIES = 10;

const money = (value: unknown) => (value ? Number(value).toFixed(2) : "0.00");

/** The fields a sale tag adds, or why this product can't have one. Pure. */
export function saleFields(
  wasPrice: number | null,
  retail: number | null,
): { wasPrice: string; saving: string; savingPercent: string } | { problem: string } {
  if (wasPrice == null) {
    return { problem: "Set this product's was price before printing a sale tag." };
  }
  if (retail == null || retail <= 0) {
    return { problem: "Set this product's retail price before printing a sale tag." };
  }
  if (wasPrice <= retail) {
    return { problem: "A sale tag's was price must be above the product's retail price." };
  }
  const saving = wasPrice - retail;
  return {
    wasPrice: wasPrice.toFixed(2),
    saving: saving.toFixed(2),
    savingPercent: String(Math.round((saving / wasPrice) * 100)),
  };
}

/** A sale's last day as a tag prints it, in the store's locale: "Nov 30, 2026". Pure. */
export function saleEndsText(endsOn: string | null, locale: string): string {
  return saleDayText(endsOn, locale);
}

/**
 * A sale tag's fields for a product priced `price` today, or why it can't have
 * one. During a scheduled sale the regular retail is the "was" price; otherwise
 * the product's own was price, as a markdown. Pure.
 */
export function saleTagFields(
  price: EffectiveRetail,
  productWasPrice: number | null,
  locale: string,
):
  | { wasPrice: string; saving: string; savingPercent: string; saleEnds: string }
  | { problem: string } {
  const read = price.onSale
    ? saleFields(price.regularPrice, price.price)
    : saleFields(productWasPrice, price.price);
  if ("problem" in read) return read;
  return { ...read, saleEnds: saleEndsText(price.saleEndsOn, locale) };
}

export async function renderProductTag(
  productId: number,
  template: { context: string; zplTemplate: string; photoDots: number | null },
): Promise<string> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      vendor: true,
      upcs: { orderBy: { sortOrder: "asc" }, take: 1, select: { upc: true } },
    },
  });
  if (!product) throw new LabelSetupError(`Product ${productId} not found`);

  const common = {
    name: product.name,
    sku: product.productNumber,
    vendor: product.vendor.name,
    // What a scanner reads back to this product (lib/scan/resolveScan.ts):
    // its first UPC, else its product number.
    barcode: product.upcs[0]?.upc ?? product.productNumber,
    width: product.width ?? "",
    depth: product.depth ?? "",
    height: product.height ?? "",
  };

  if (template.context === "LAW") {
    if (!product.lawTagText) {
      throw new LabelSetupError("Add this product's law tag wording before printing a law tag.");
    }
    return renderTemplate(template.zplTemplate, { ...common, lawText: product.lawTagText });
  }

  const { costCipherKey, timezone, locale } = await getAppSettings();
  // What the register charges today, on the store's day: a sale price while a
  // scheduled sale is on (lib/pricing/salePrice.ts).
  const today = businessDayKey(new Date(), timezone);
  const price = effectiveRetail({
    baseRetail: product.baseRetail,
    sale: (await loadActiveSalePrices([product.id], today, prisma)).get(product.id),
  });

  let sale = {};
  if (template.context === "SALE") {
    const read = saleTagFields(
      price,
      product.wasPrice == null ? null : Number(product.wasPrice),
      locale,
    );
    if ("problem" in read) throw new LabelSetupError(read.problem);
    sale = read;
  }

  // The cost stock is valued at: the landed cost, else the catalog cost (GAP-02).
  const cost = product.landedCost ?? product.baseCost;
  return renderTemplate(template.zplTemplate, {
    ...common,
    baseCost: money(product.baseCost),
    baseRetail: money(price.price),
    costCode: costCode(cost == null ? null : Number(cost), costCipherKey),
    photo: await photoField(product.imageUrl, template.photoDots),
    ...sale,
  });
}
