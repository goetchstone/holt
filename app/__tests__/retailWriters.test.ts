// /app/__tests__/retailWriters.test.ts
//
// A manifest and a tripwire (rule 65) for the one retail writer (GAP-06,
// DECISIONS 58). A price lock on one path is no lock (rule 42): if any route or
// importer writes an existing product's baseRetail without going through
// lib/pricing/retailWriter.ts, a locked price is overwritten and the change is
// missing from the price ledger. Source text is right for this class -- "every
// writer must go through the guard" (rule 57); what the writer does is tested
// for real in integration/retailWriter.integration.test.ts.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const APP = join(__dirname, "..");
const MANIFEST = join(__dirname, "fixtures", "retail-writers.txt");

/** A call that writes Product rows. */
const PRODUCT_WRITE = /\bproduct\.(create|createMany|update|updateMany|upsert)\(/;
/**
 * baseRetail as an object key, quoted or not, or as shorthand -- `{ baseRetail }`
 * and `{ name, baseRetail }` on one line included, as Prettier leaves a short
 * object -- a select's `baseRetail: true` aside. A destructure
 * (`const { baseRetail } = row`) counts too, in a file that writes products; a
 * quoted name in a list (`["baseRetail", ...]`, a column in SQL) does not.
 */
const RETAIL_KEY =
  /(?<![.\w"'])baseRetail\s*(?::(?!\s*true\b)|[,}])|["']baseRetail["']\s*:(?!\s*true\b)/g;
/** An assignment into a data object: `data.baseRetail = ...` or `data["baseRetail"] = ...`. */
const RETAIL_ASSIGN = /(?:\.baseRetail|\[\s*["']baseRetail["']\s*\])\s*=(?!=)/g;
/** A computed key: `{ ["baseRetail"]: x }`. */
const RETAIL_COMPUTED_KEY = /\[\s*["']baseRetail["']\s*\]\s*:/g;
/** Raw SQL that sets it. */
const RAW_SQL = /UPDATE\s+"?Product"?[\s\S]{0,400}"baseRetail"\s*=/g;

function filesUnder(dir: string): string[] {
  return readdirSync(join(APP, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    if (statSync(join(APP, path)).isDirectory()) return filesUnder(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The baseRetail keys a source file writes, by the rules above. */
export function retailKeysWritten(source: string): number {
  if (!PRODUCT_WRITE.test(source) && !RAW_SQL.test(source)) return 0;
  RAW_SQL.lastIndex = 0;
  return (
    (source.match(RETAIL_KEY)?.length ?? 0) +
    (source.match(RETAIL_ASSIGN)?.length ?? 0) +
    (source.match(RETAIL_COMPUTED_KEY)?.length ?? 0) +
    (source.match(RAW_SQL)?.length ?? 0)
  );
}

interface Entry {
  path: string;
  kind: string;
  keys: number;
  reason: string;
}

function readManifest(): Entry[] {
  return readFileSync(MANIFEST, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [path, kind, keys, ...reason] = line.split("|").map((part) => part.trim());
      return { path, kind, keys: Number(keys), reason: reason.join("|").trim() };
    });
}

function scan(): Map<string, number> {
  const found = new Map<string, number>();
  for (const file of filesUnder("src")) {
    const keys = retailKeysWritten(readFileSync(join(APP, file), "utf8"));
    if (keys > 0) found.set(file, keys);
  }
  return found;
}

describe("every writer of a product's retail is listed and goes through the writer", () => {
  const manifest = readManifest();
  const found = scan();

  it("finds the writers it's meant to, so the patterns can't quietly match nothing", () => {
    expect(found.get("src/lib/pricing/retailWriter.ts")).toBeGreaterThan(0);
    expect(found.has("src/pages/api/products/basic.ts")).toBe(true);
    expect(found.size).toBeGreaterThanOrEqual(10);
  });

  it("lists every file that writes baseRetail, with the count it has", () => {
    const listed = new Map(manifest.map((e) => [e.path, e.keys]));
    const unlisted = [...found].filter(([path, keys]) => listed.get(path) !== keys);
    expect(unlisted.map(([path, keys]) => `${path} | ? | ${keys}`)).toEqual([]);
  });

  it("lists nothing that no longer writes it (a stale line lies about the set)", () => {
    const stale = manifest.filter((e) => !found.has(e.path)).map((e) => e.path);
    expect(stale).toEqual([]);
  });

  it("classifies each line, with a reason", () => {
    for (const entry of manifest) {
      expect(["writer", "create-only"]).toContain(entry.kind);
      expect(entry.reason.length).toBeGreaterThan(10);
      expect(existsSync(join(APP, entry.path))).toBe(true);
    }
  });

  it("has each writer use the retail writer", () => {
    const bypass = manifest
      .filter((e) => e.kind === "writer" && e.path !== "src/lib/pricing/retailWriter.ts")
      .filter(
        (e) => !readFileSync(join(APP, e.path), "utf8").includes('"@/lib/pricing/retailWriter"'),
      )
      .map((e) => e.path);
    expect(bypass).toEqual([]);
  });
});

describe("the scan's patterns", () => {
  it("counts keys, shorthand and assignments in a file that writes products", () => {
    const source = `
      await tx.product.update({ where: { id }, data: { baseRetail: 9, name } });
      const data = { baseRetail, cost };
      data.baseRetail = 10;
    `;
    expect(retailKeysWritten(source)).toBe(3);
  });

  it("counts shorthand last on one line, quoted keys and bracket writes", () => {
    // Each of these slipped past an earlier pattern that only saw shorthand
    // before a comma or a line break.
    const forms = [
      "await prisma.product.update({ where: { id }, data: { baseRetail } });",
      "await prisma.product.update({ where: { id }, data: { name, baseRetail } });",
      "await prisma.product.update({ where: { id }, data: { ...rest, baseRetail} });",
      'await prisma.product.update({ where: { id }, data: { "baseRetail": 9 } });',
      'await prisma.product.update({ where: { id }, data: { ["baseRetail"]: 9 } });',
      'data["baseRetail"] = 9; await prisma.product.update({ where: { id }, data });',
    ];
    for (const form of forms) expect([form, retailKeysWritten(form)]).toEqual([form, 1]);
  });

  it("leaves selects, reads and comparisons out", () => {
    const source = `
      await prisma.product.update({ where: { id }, data: { name } });
      const p = await prisma.product.findFirst({ select: { baseRetail: true } });
      const fields = ["baseRetail", "mapPrice"];
      if (p.baseRetail === 3) return p.baseRetail;
    `;
    expect(retailKeysWritten(source)).toBe(0);
  });

  it("ignores a file that writes no product", () => {
    expect(retailKeysWritten("await tx.vendorStyle.upsert({ create: { baseRetail: 5 } });")).toBe(
      0,
    );
  });
});
