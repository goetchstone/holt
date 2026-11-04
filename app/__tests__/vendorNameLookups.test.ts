// /app/__tests__/vendorNameLookups.test.ts
//
// GAP-22: a vendor merged into another leaves its name behind as an alias
// (VendorAlias), and lib/vendors/vendorByName.ts finds the kept vendor through
// it. Code that finds a vendor by name some other way misses the alias, and if
// it then creates a vendor, the next import brings the merged-away duplicate
// back. That is a "the guard must be on every path" class, so a source scan is
// the right instrument (rule 57); the lookups themselves are tested on a real
// database in vendorMerge.integration.test.ts.
//
// Two checks, each failing both ways (rule 65):
//   - creating a vendor anywhere but vendorByName.ts needs a line below saying
//     why it is safe, and a line whose site is gone fails as stale;
//   - finding a vendor with a `where` on its name anywhere but vendorByName.ts
//     fails outright.
// What it can't see: a list of every vendor read into a name map without a
// `where` (a runner's cache). Those go through vendorNameIndex; a new one that
// doesn't still misses aliases, but it can't create a vendor without tripping
// the first check.

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const APP = join(__dirname, "..");
const SRC = join(APP, "src");
const HOME = "src/lib/vendors/vendorByName.ts";

/** Vendor creates outside vendorByName.ts, each with why it can't make a duplicate. */
const ALLOWED_CREATES: Record<string, { count: number; reason: string }> = {
  "src/lib/genericImportRunner.ts": {
    count: 1,
    reason: "the vendor import's writeVendorRow creates only after findVendorByName found nothing",
  },
  "src/pages/api/vendors/index.ts": {
    count: 1,
    reason: "the vendor screen's add refuses a name findVendorByName finds, ignoring case",
  },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

/** The argument text of a call starting at `open` (the index of its "("). */
function argumentOf(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

function vendorCreates(text: string): number {
  return [...text.matchAll(/\bvendor\.(create|upsert|createMany)\(/g)].length;
}

function vendorFindsByName(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\bvendor\.(findFirst|findUnique|findMany)(OrThrow)?\(/g)) {
    const args = argumentOf(text, m.index + m[0].length - 1);
    if (/where:\s*\{[^{}]*\bname\s*:/.test(args) || /where:\s*\{\s*name\b/.test(args)) {
      found.push(m[0] + args.replace(/\s+/g, " ").slice(0, 80));
    }
  }
  return found;
}

const files = sourceFiles(SRC)
  .map((path) => ({ file: relative(APP, path), text: readFileSync(path, "utf8") }))
  .filter(({ file }) => file !== HOME);

describe("vendors are found and created by name only through vendorByName.ts", () => {
  it("creates a vendor elsewhere only where a line here says why it's safe", () => {
    const creates = Object.fromEntries(
      files.map(({ file, text }) => [file, vendorCreates(text)]).filter(([, n]) => n),
    );
    const allowed = Object.fromEntries(
      Object.entries(ALLOWED_CREATES).map(([file, { count }]) => [file, count]),
    );
    expect(creates).toEqual(allowed);
  });

  it("gives every allowed create a reason", () => {
    for (const { reason } of Object.values(ALLOWED_CREATES))
      expect(reason.length).toBeGreaterThan(20);
  });

  it("finds a vendor by name nowhere else", () => {
    const finds = files.flatMap(({ file, text }) =>
      vendorFindsByName(text).map((call) => `${file}: ${call}`),
    );
    expect(finds).toEqual([]);
  });

  it("sees the shapes it is looking for, so the checks above can fail", () => {
    expect(vendorCreates("await tx.vendor.create({ data: { name } })")).toBe(1);
    expect(vendorCreates("prisma.vendor.upsert({ where: { name } })")).toBe(1);
    expect(
      vendorFindsByName(
        'await prisma.vendor.findFirst({\n  where: { name: { equals: n, mode: "insensitive" } },\n})',
      ),
    ).toHaveLength(1);
    expect(
      vendorFindsByName("tx.vendor.findUnique({ where: { name: record.vendorName } })"),
    ).toHaveLength(1);
    expect(
      vendorFindsByName('vendor.findMany({ where: { isConsignment: true, name: "X" } })'),
    ).toHaveLength(1);
    expect(vendorFindsByName("prisma.vendor.findUnique({ where: { id: vendorId } })")).toEqual([]);
    expect(vendorFindsByName("vendor.findMany({ select: { id: true, name: true } })")).toEqual([]);
  });
});
