// /app/__tests__/orderAndPoDeletes.test.ts
//
// A manifest and a tripwire (rule 65) for every place that deletes a purchase
// order, a sales order, or the lines of either. Orders and POs are cancelled,
// not deleted; a delete belongs only behind a guard that proves nothing has been
// built on the rows. Three upload routes had none (principle 3: the guard was on
// the editors and not on the imports).
//
// Source text is right for this class: "a new delete must be listed with its
// guard" (rule 57). What each guard refuses is tested for real, in
// integration/reimportsFailClosed.integration.test.ts and the suites of the
// editors named in the manifest.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const APP = join(__dirname, "..");
const MANIFEST = join(__dirname, "fixtures", "order-and-po-deletes.txt");

/** A Prisma delete on one of the four models, through any client or transaction. */
const DELETE_CALL =
  /\b(?:purchaseOrder|purchaseOrderItem|salesOrder|orderLineItem)\.(?:delete|deleteMany)\(/g;
/** The same in raw SQL. */
const RAW_DELETE =
  /DELETE\s+FROM\s+"?(?:PurchaseOrder|PurchaseOrderItem|SalesOrder|OrderLineItem)"?(?![A-Za-z])/gi;
/** A nested write that deletes lines through their parent. */
const NESTED_DELETE = /\b(?:lineItems|purchaseOrderItems)\s*:\s*\{\s*(?:delete|deleteMany)\b/g;

export function deletesIn(source: string): number {
  return (
    (source.match(DELETE_CALL)?.length ?? 0) +
    (source.match(RAW_DELETE)?.length ?? 0) +
    (source.match(NESTED_DELETE)?.length ?? 0)
  );
}

function filesUnder(dir: string): string[] {
  return readdirSync(join(APP, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    if (statSync(join(APP, path)).isDirectory()) return filesUnder(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

interface Entry {
  path: string;
  deletes: number;
  guard: string;
  reason: string;
}

function readManifest(): Entry[] {
  return readFileSync(MANIFEST, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [path, deletes, guard, ...reason] = line.split("|").map((part) => part.trim());
      return { path, deletes: Number(deletes), guard, reason: reason.join("|").trim() };
    });
}

function scan(): Map<string, number> {
  const found = new Map<string, number>();
  for (const file of filesUnder("src")) {
    const deletes = deletesIn(readFileSync(join(APP, file), "utf8"));
    if (deletes > 0) found.set(file, deletes);
  }
  return found;
}

describe("deletes of orders, POs and their lines", () => {
  const manifest = readManifest();
  const found = scan();

  it("finds a delete written each way the scan claims to", () => {
    expect(deletesIn("await tx.purchaseOrder.delete({ where: { id } });")).toBe(1);
    expect(deletesIn("prisma.orderLineItem.deleteMany({ where });\ntx.salesOrder.delete(x)")).toBe(
      2,
    );
    expect(deletesIn('await tx.$executeRaw`DELETE FROM "PurchaseOrderItem" WHERE id = 1`')).toBe(1);
    expect(deletesIn("data: { lineItems: { deleteMany: {} } }")).toBe(1);
    // Not deletes of these rows.
    expect(deletesIn("await tx.purchaseOrderCharge.deleteMany({ where });")).toBe(0);
    expect(deletesIn("await tx.orderChangeLog.deleteMany({ where });")).toBe(0);
    expect(deletesIn('DELETE FROM "SalesOrderDraft"')).toBe(0);
  });

  it("lists every file that deletes one, with the number of deletes it has", () => {
    const listed = new Map(manifest.map((e) => [e.path, e.deletes]));
    // A file here and not in the manifest is a new delete: give it a guard and list it.
    expect([...found].sort()).toEqual([...listed].sort());
  });

  it("gives each a guard that is still in the file, and a reason", () => {
    for (const entry of manifest) {
      const source = readFileSync(join(APP, entry.path), "utf8");
      expect({ path: entry.path, hasGuard: source.includes(entry.guard) }).toEqual({
        path: entry.path,
        hasGuard: true,
      });
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });
});
