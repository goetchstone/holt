// /app/__tests__/vendorMergeCoverage.test.ts
//
// GAP-22: a vendor merge (lib/vendors/mergeVendor.ts) moves every row that
// names the duplicate, then deletes it. A table that names a vendor and isn't
// moved either blocks the delete (a RESTRICT foreign key, so every merge fails)
// or quietly loses its vendor (SET NULL, which for a commission rule means
// every vendor). Neither shows until someone merges.
//
// So the set is written down (VENDOR_REFERENCES) and this checks it against the
// schema both ways, as rule 65 asks: a model with a vendor column that the list
// leaves out fails, and so does a listed model the schema no longer has. Every
// model the list says is moved must be one the merge actually moves (MOVED).
// The integration test (vendorMerge.integration.test.ts) proves the moves on a
// real database.

import { readFileSync } from "fs";
import { join } from "path";
import { MOVED, VENDOR_REFERENCES } from "@/lib/vendors/mergeVendor";

const SCHEMA = readFileSync(join(__dirname, "..", "prisma", "schema.prisma"), "utf8");

/** Every model with a relation to Vendor or a vendorId column (Collection has no foreign key). */
function modelsNamingAVendor(): string[] {
  const found: string[] = [];
  for (const m of SCHEMA.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const [, name, body] = m;
    if (name === "Vendor") continue;
    const fields = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => !l.startsWith("//"))
      .map((l) => l.split(/\s+/));
    const names = fields.some(
      ([field, type]) => type === "Vendor" || type === "Vendor?" || field === "vendorId",
    );
    if (names) found.push(name);
  }
  return found.sort();
}

const delegateOf = (model: string) => model[0].toLowerCase() + model.slice(1);

describe("every table that names a vendor is handled by a merge", () => {
  it("lists every model with a vendor column, and nothing the schema doesn't have", () => {
    expect(Object.keys(VENDOR_REFERENCES).sort()).toEqual(modelsNamingAVendor());
  });

  it("moves exactly the models it says are moved", () => {
    const saysMoved = Object.entries(VENDOR_REFERENCES)
      .filter(([, handling]) => handling.startsWith("moved"))
      .map(([model]) => delegateOf(model))
      .sort();
    expect(MOVED.map(([delegate]) => delegate).sort()).toEqual(saysMoved);
  });

  it("finds the models it should, so the check above can fail", () => {
    const models = modelsNamingAVendor();
    // A foreign key, a nullable one, and the vendorId with no foreign key.
    expect(models).toEqual(expect.arrayContaining(["Product", "ServiceCase", "Collection"]));
    expect(models).not.toContain("Vendor");
  });
});
