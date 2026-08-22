// /app/__tests__/coreModelsAreVendorNeutral.test.ts
//
// A core table may not carry one source system's vocabulary.
//
// SalesOrder held `skipSameDayRewriteCleanup` -- a boolean only the Ordorite
// importer ever read, describing that source's rewrite quirks rather than
// anything about the sale, on the highest-traffic table in the product. It was
// set on 1 order in 49,769. Adapter state now lives in AdapterOrderFlag, keyed
// by (salesOrderId, adapter, flag), so a second adapter needs no schema change.
//
// This is a RATCHET on the schema. Vendor names and source-system concepts are
// cheap to add to a model and expensive to remove once every deployment has the
// column, so the check is here rather than in a reviewer's memory.

import { readFileSync } from "fs";
import { join } from "path";

const SCHEMA = join(__dirname, "..", "prisma", "schema.prisma");

/** Models that belong to the product, not to any one integration. */
const CORE_MODELS = [
  "SalesOrder",
  "OrderLineItem",
  "Customer",
  "Product",
  "Payment",
  "JournalEntry",
  "StaffMember",
  "InventoryPosition",
];

/**
 * Vendor and source-system words that must not appear in a core model's fields.
 *
 * `axper` is listed and TrafficSnapshot is not a core model, which is the point:
 * the column is still there and still wrong, just not on this list's tables yet.
 */
const VENDOR_WORDS = [
  "ordorite",
  "axper",
  "marjan",
  "mailchimp",
  "windfall",
  "sameDayRewrite",
  "nuorder",
];

/**
 * Vendor-named fields on core models that already exist, each with why.
 *
 * A ratchet, not an amnesty: the list may shrink, never grow. Freezing what is
 * here keeps the check honest today while the next one is being fixed, which is
 * better than deleting the check because it fails.
 */
const ACCEPTED: Record<string, string> = {
  "Customer.mailchimpActivities":
    "Back-relation to MailchimpActivity, which is the integration's own table. The coupling belongs there; without the relation the join cannot be expressed at all. Removing the vendor's name here would mean renaming its table, which does not make the product less coupled.",
  "Customer.windfallEnrichment":
    "Back-relation to WindfallEnrichment, the integration's own table. Same reasoning as mailchimpActivities.",
  "Customer.mailchimpSyncedAt":
    "A genuine leak, unlike the two relations: a scalar on a core table recording one integration's sync clock. Belongs in integration-owned state, the same shape AdapterOrderFlag gives adapters. Not fixed here to keep this change to one thing.",
};

function fieldsOf(model: string): string[] {
  const src = readFileSync(SCHEMA, "utf8");
  const m = new RegExp(`^model\\s+${model}\\s*\\{([\\s\\S]*?)^\\}`, "m").exec(src);
  if (!m) throw new Error(`model ${model} not found in schema.prisma`);
  return m[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//") && !l.startsWith("///") && !l.startsWith("@@"))
    .map((l) => l.split(/\s+/)[0]);
}

describe("core models carry no source-system vocabulary", () => {
  it("finds the models it was written for, so the scan is not silently empty", () => {
    expect(fieldsOf("SalesOrder").length).toBeGreaterThan(20);
    expect(fieldsOf("SalesOrder")).toContain("orderno");
  });

  it("names no vendor or source concept in a core model's fields", () => {
    const offenders: string[] = [];
    for (const model of CORE_MODELS) {
      for (const field of fieldsOf(model)) {
        const lower = field.toLowerCase();
        for (const word of VENDOR_WORDS) {
          const key = `${model}.${field}`;
          if (lower.includes(word.toLowerCase()) && !(key in ACCEPTED)) offenders.push(key);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("justifies every accepted field, and lists none that has been fixed", () => {
    // A stale entry silently pre-approves reintroducing the field later.
    for (const [key, reason] of Object.entries(ACCEPTED)) {
      expect(reason.length).toBeGreaterThan(60);
      const [model, field] = key.split(".");
      expect(fieldsOf(model)).toContain(field);
    }
  });

  it("keeps SalesOrder free of the flag that started this", () => {
    // Regression pin: the column, by name, on the table it was removed from.
    expect(fieldsOf("SalesOrder")).not.toContain("skipSameDayRewriteCleanup");
  });

  it("gives adapters somewhere else to put it", () => {
    // Without this the rule is just "no", and the next adapter adds a column.
    const src = readFileSync(SCHEMA, "utf8");
    expect(src).toMatch(/^model\s+AdapterOrderFlag\s*\{/m);
    expect(fieldsOf("AdapterOrderFlag")).toEqual(expect.arrayContaining(["adapter", "flag"]));
  });
});
