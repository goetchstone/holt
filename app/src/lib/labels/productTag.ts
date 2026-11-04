// /app/src/lib/labels/productTag.ts
//
// What goes on a product's tags (GAP-18): the price tag, the sale tag and the law
// tag. A template's context decides which fields it gets, so a tag printed from
// any path means the same thing.
//
// THE SALE TAG. Its price is the product's retail, which is what the register
// charges, so a tag and a sale can't disagree. wasPrice is the price it started
// at, set on the product. Holt has no sale prices of its own yet (GAP-06), so a
// markdown is a change to retail plus a was price.
//
// THE LAW TAG. What the law asks a tag to say depends on where the store is, so
// the wording is the store's template (rule 61), and the product supplies its own
// part: what it's made of, as lawTagText.
//
// A tag a product can't have is refused with the reason, not printed half empty.

import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/appSettings";
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

  let sale = {};
  if (template.context === "SALE") {
    const read = saleFields(
      product.wasPrice == null ? null : Number(product.wasPrice),
      product.baseRetail == null ? null : Number(product.baseRetail),
    );
    if ("problem" in read) throw new LabelSetupError(read.problem);
    sale = read;
  }

  const { costCipherKey } = await getAppSettings();
  // The cost stock is valued at: the landed cost, else the catalog cost (GAP-02).
  const cost = product.landedCost ?? product.baseCost;
  return renderTemplate(template.zplTemplate, {
    ...common,
    baseCost: money(product.baseCost),
    baseRetail: money(product.baseRetail),
    costCode: costCode(cost == null ? null : Number(cost), costCipherKey),
    photo: await photoField(product.imageUrl, template.photoDots),
    ...sale,
  });
}
