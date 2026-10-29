// /app/prisma/seed/demo/priceBooks.ts
//
// Five mock vendors with real-shaped price books, loaded through the SAME
// importers a store's own books go through, so the demo exercises them:
//   - three special-order upholstery lines in the standard layout
//     (lib/pricing/standardPriceBook.ts), parsed and validated like the
//     import screen does, then written by lib/pricing/importWholesaleBook.ts;
//   - two flat-priced lines (lighting; mirrors and decor with case packs)
//     through the generic product import (lib/genericImportRunner.ts).
//
// Every vendor, style and price here is INVENTED (this repo is public, and a
// real line's costs are its dealers' confidential terms). A web search on
// 2026-10-29 found no furniture brand by any of the five names. The books
// live beside this file in pricebooks/. A client's own price book is shown
// only to that client, in their deployment; it is never committed.
//
// Draws nothing from the RNG and runs after every other module, so the rest
// of the demo data -- ids included -- is unchanged by it.

import { readFileSync } from "fs";
import { join } from "path";
import Papa from "papaparse";
import type { PrismaClient } from "@prisma/client";
import { parseStandardPriceBookCsv } from "@/lib/pricing/standardPriceBook";
import { importWholesaleBook } from "@/lib/pricing/importWholesaleBook";
import { wholesaleImportSchema } from "@/lib/validation/schemas";
import { runGenericImport } from "@/lib/genericImportRunner";
import { getImportEntity, suggestMapping } from "@/lib/genericImport";

const SEED_ACTOR = "seed:demo";
const BOOK_DIR = join(__dirname, "pricebooks");

interface BookVendor {
  name: string;
  code: string;
  file: string;
  leadTimeDays: number;
  paymentTerms: string;
  /** Retail = cost x this, for a special-order line (Vendor.defaultMarkup).
   *  A demo assumption in the range furniture stores use, not a fact. */
  markup?: number;
  kind: "standard" | "flat";
}

export const PRICE_BOOK_VENDORS: readonly BookVendor[] = [
  {
    name: "Vellmora Recliner Co.",
    code: "VRC",
    file: "vellmora-recliner-co.csv",
    leadTimeDays: 56,
    paymentTerms: "Net 30",
    markup: 2.0,
    kind: "standard",
  },
  {
    name: "Larkmoor Leatherworks",
    code: "LL",
    file: "larkmoor-leatherworks.csv",
    leadTimeDays: 42,
    paymentTerms: "Net 30",
    markup: 2.2,
    kind: "standard",
  },
  {
    name: "Pellwood Custom Upholstery",
    code: "PCU",
    file: "pellwood-custom-upholstery.csv",
    leadTimeDays: 63,
    paymentTerms: "Net 45",
    markup: 2.4,
    kind: "standard",
  },
  {
    name: "Brasswick Lighting Co.",
    code: "BL",
    file: "brasswick-lighting.csv",
    leadTimeDays: 21,
    paymentTerms: "Net 30",
    kind: "flat",
  },
  {
    name: "Tidewell Mirror & Decor Imports",
    code: "TMDI",
    file: "tidewell-mirror-decor.csv",
    leadTimeDays: 35,
    paymentTerms: "Net 60",
    kind: "flat",
  },
];

/** The store-wide markup a vendor without its own falls back to
 *  (AppSettings.pricing.defaultMarkup) -- so a vendor a visitor imports
 *  through the standard layout prices straight away. A demo assumption. */
const STORE_DEFAULT_MARKUP = 2.2;

/** The department whose GL accounts the import's upholstery category books to. */
const UPHOLSTERY_ACCOUNT_DEPARTMENT = "Living Room";

function readBook(file: string): string {
  return readFileSync(join(BOOK_DIR, file), "utf8");
}

async function importStandardBook(vendor: BookVendor, vendorId: number, asOf: Date) {
  const parsed = parseStandardPriceBookCsv(readBook(vendor.file));
  // These books are ours: a single warning means the book or the parser is
  // wrong, and the demo should say so rather than import half of it.
  if (parsed.diagnostics.length > 0) {
    throw new Error(
      `${vendor.file}: ${parsed.diagnostics.map((d) => `row ${d.row ?? "-"}: ${d.message}`).join("; ")}`,
    );
  }
  const book = wholesaleImportSchema.parse({
    vendorId,
    priceListName: `${vendor.name} Wholesale`,
    effectiveDate: asOf.toISOString(),
    mode: "renew",
    sourceBook: "wholesale",
    products: parsed.data,
  });
  const outcome = await importWholesaleBook(book, SEED_ACTOR);
  if (outcome.kind !== "ok" || outcome.importedCount !== parsed.data.length) {
    throw new Error(`${vendor.file}: import ${JSON.stringify(outcome)}`);
  }
  return outcome.importedCount;
}

async function importFlatBook(vendor: BookVendor) {
  const rows = Papa.parse<Record<string, string>>(readBook(vendor.file), {
    header: true,
    skipEmptyLines: true,
  }).data;
  const entity = getImportEntity("product");
  if (!entity) throw new Error("the product import entity is missing");
  const mapping = suggestMapping(Object.keys(rows[0] ?? {}), entity);
  const result = await runGenericImport("product", mapping, rows, SEED_ACTOR);
  if (result.errors.length > 0 || result.imported !== rows.length) {
    throw new Error(`${vendor.file}: ${JSON.stringify(result)}`);
  }
  return result.imported;
}

export async function seedPriceBooks(
  prisma: PrismaClient,
  opts: { organizationId: number; asOf: Date; accountGroupIdByDepartment: Map<string, number> },
): Promise<{ vendors: number; styles: number; products: number }> {
  let styles = 0;
  let products = 0;
  for (const v of PRICE_BOOK_VENDORS) {
    const vendor = await prisma.vendor.create({
      data: {
        name: v.name,
        code: v.code,
        pricingModel: "FLAT",
        defaultMarkup: v.markup ?? null,
        leadTimeDays: v.leadTimeDays,
        paymentTerms: v.paymentTerms,
        freightTerms: "FOB Factory",
        email: `orders@${v.code.toLowerCase()}.example.com`,
        createdBy: SEED_ACTOR,
      },
    });
    if (v.kind === "standard") styles += await importStandardBook(v, vendor.id, opts.asOf);
    else products += await importFlatBook(v);
  }

  // The wholesale import files every special-order style under its own
  // "Upholstered Furniture" category; give it the living-room accounts so a
  // configured sale books like the rest of the floor.
  const livingRoomGroup = opts.accountGroupIdByDepartment.get(UPHOLSTERY_ACCOUNT_DEPARTMENT);
  if (livingRoomGroup != null) {
    await prisma.category.updateMany({
      where: { name: "Upholstered Furniture", accountGroupId: null },
      data: { accountGroupId: livingRoomGroup },
    });
  }

  await prisma.appSettings.update({
    where: { organizationId: opts.organizationId },
    data: { pricing: { defaultMarkup: STORE_DEFAULT_MARKUP } },
  });

  return { vendors: PRICE_BOOK_VENDORS.length, styles, products };
}
