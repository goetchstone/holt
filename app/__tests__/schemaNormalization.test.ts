// /app/__tests__/schemaNormalization.test.ts
//
// Guards third normal form where it actually costs something: a text column
// sitting next to the foreign key that already determines it.
//
// 3NF asks that every non-key column depend on the key and nothing but the key.
// `salesPersonId` + `salesperson` breaks that — the name depends on the staff
// member, not on the order — so the same fact lives twice and the two disagree.
// The reference dataset shows the bill: 69 distinct spellings for 42 staff, and
// 28% of orders whose text names a salesperson with no StaffMember row at all.
// designerDashboard.ts pays it by OR-matching across the name, the FK and an
// alias list on every query.
//
// This is a RATCHET, not a cleanup. Each pair below was measured and accepted;
// what the test stops is a NEW one appearing unnoticed. Adding a text column
// beside its own FK now fails here and has to be argued for in writing.
//
// Snapshots are not violations and are not listed: OrderLineItem.productName,
// netPrice and cost record what was sold at what price on the day, and renaming
// a product must not rewrite history.

import { readFileSync } from "fs";
import { join } from "path";

const SCHEMA = join(__dirname, "..", "prisma", "schema.prisma");

/**
 * Accepted text-beside-FK pairs, each with the measurement that justified it.
 * A pair earns a place here by being harmless in the data, not by being old.
 */
const ACCEPTED: Record<string, string> = {
  "SalesOrder.salesperson":
    "The one real violation. 13,931 of 49,769 orders (28%) carry a name with no StaffMember row — mostly departed staff and numbered POS terminals from the Ordorite import. The text is the ONLY record those sales happened, so it cannot be dropped until each name is classified. backfillSalesPersonFk already resolves every name that maps to a staff member; 8 orders remain resolvable.",
  "SalesOrder.storeLocation":
    "Consistent mirror: 73 of 49,769 rows unresolved (0.15%), and exactly 5 distinct spellings against 5 StoreLocation rows. Migrating six models and their readers to fix 73 rows is churn.",
  "Payment.storeLocation":
    "Consistent mirror: 39 of 47,880 rows unresolved (0.08%), 5 spellings against 5 StoreLocation rows.",
  "JournalEntry.storeLocation":
    "Zero unresolved rows in the reference dataset. The text is written by the journal generator alongside the FK it just resolved.",
  "StaffShift.storeLocation":
    "Zero unresolved rows in the reference dataset; 3 spellings, all resolving.",
  "CustomerInteraction.storeLocation":
    "StoreLocation mirror, same as SalesOrder and Payment: 5 spellings against 5 StoreLocation rows, written alongside the FK rather than instead of it.",
  "UpBoardEntry.storeLocation":
    "StoreLocation mirror. The up-board is per-store and always writes both, so the text has never diverged from the FK in the reference dataset.",
  "ServiceCase.storeLocation":
    "StoreLocation mirror. Service cases are opened against a store and record both; no unresolved rows in the reference dataset.",
  "InventoryTransfer.fromLocation":
    "Transfer endpoints are recorded as text as well as FK so a transfer reads correctly after a location is renamed or retired — closer to a snapshot than a mirror.",
  "InventoryTransfer.toLocation":
    "Destination endpoint of a transfer, recorded as text as well as FK so the movement still reads correctly after a location is renamed or retired.",
  "ReceivingRecord.destinationLocation":
    "Where goods physically landed, kept as text as well as FK so a receipt stays readable after the location is renamed or retired. Closer to a snapshot than a mirror.",
  "ServiceCase.externalSource":
    "Not a denormalization: externalSource names the SYSTEM and externalSourceId the record within it. Neither determines the other; together they are one external reference.",
  "ServiceCaseNote.externalSource":
    "Not a denormalization: externalSource names the SYSTEM a note came from and externalSourceId the record within it. Neither determines the other.",
};

interface Pair {
  model: string;
  text: string;
  fk: string;
}

function denormalizedPairs(): Pair[] {
  const src = readFileSync(SCHEMA, "utf8");
  const pairs: Pair[] = [];
  for (const m of src.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, model, body] = m;
    const cols = new Map<string, string>();
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("//") || t.startsWith("///") || t.startsWith("@@")) continue;
      const c = /^(\w+)\s+(\S+)/.exec(t);
      if (c) cols.set(c[1], c[2]);
    }
    for (const [col] of cols) {
      if (!col.endsWith("Id")) continue;
      const base = col.slice(0, -2);
      // Match case-insensitively: the schema carries both `salesPersonId` +
      // `salesperson` and `storeLocationId` + `storeLocation`.
      for (const [other, type] of cols) {
        if (other === col) continue;
        if (other.toLowerCase() !== base.toLowerCase()) continue;
        if (type !== "String" && type !== "String?") continue;
        pairs.push({ model, text: other, fk: col });
      }
    }
  }
  return pairs;
}

describe("no new text-beside-its-own-FK columns", () => {
  it("finds the pairs it was written for, so the scan is not silently empty", () => {
    // If the parser stops matching, every assertion below passes vacuously.
    const pairs = denormalizedPairs();
    expect(pairs.length).toBeGreaterThan(8);
    expect(pairs.map((p) => `${p.model}.${p.text}`)).toContain("SalesOrder.salesperson");
  });

  it("every pair in the schema is one that was measured and accepted", () => {
    const unaccepted = denormalizedPairs()
      .map((p) => `${p.model}.${p.text}`)
      .filter((k) => !(k in ACCEPTED));
    expect(unaccepted).toEqual([]);
  });

  it("lists no pair the schema no longer has", () => {
    // A stale entry would silently pre-approve a column reintroduced later.
    const present = new Set(denormalizedPairs().map((p) => `${p.model}.${p.text}`));
    expect(Object.keys(ACCEPTED).filter((k) => !present.has(k))).toEqual([]);
  });

  it("justifies each accepted pair with more than a shrug", () => {
    for (const [pair, reason] of Object.entries(ACCEPTED)) {
      expect(reason.length).toBeGreaterThan(60);
    }
  });
});
