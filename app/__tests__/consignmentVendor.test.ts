// /app/__tests__/consignmentVendor.test.ts
//
// Consignment routes used to find "the consignment vendor" by NAME: 38
// references across 12 files, one import route carrying six spellings, and an
// ILIKE in raw SQL. Three of those routes went further and CREATED a vendor
// called "Marjan International" when they could not find one -- which is how a
// catalog acquires three suppliers who are the same company.
//
// Vendor.isConsignment is the fact all of that was reaching for. These pin the
// two behaviours that matter: resolution never depends on a name, and a missing
// configuration is an error rather than a new vendor.

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const APP = join(__dirname, "..");
const SRC = join(APP, "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Comments describe history; only code decides behaviour. */
function codeOf(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}

/**
 * The one remaining allowance, with why.
 *
 * The adapter routes an incoming report by FILENAME, and the source system names
 * that file after the vendor. It is matching its own export's name, not deciding
 * which vendor consigns -- and the pattern list is the adapter's business.
 */
const ALLOWED = new Set(["src/lib/adapters/ordorite/reportRouter.ts"]);

describe("no route resolves the consignment vendor by name", () => {
  const files = walk(SRC);

  it("finds the files it was written for, so the scan is not silently empty", () => {
    expect(files.length).toBeGreaterThan(400);
  });

  it("names no consignment vendor in code", () => {
    const offenders = files
      .filter((f) => /marjan/i.test(codeOf(readFileSync(f, "utf8"))))
      .map((f) => relative(APP, f))
      .filter((r) => !ALLOWED.has(r));
    expect(offenders).toEqual([]);
  });

  it("keeps the allowance pointed at a file that still exists", () => {
    for (const rel of ALLOWED) {
      expect(files.map((f) => relative(APP, f))).toContain(rel);
    }
  });
});

describe("a missing configuration is an error, never a new vendor", () => {
  const CREATORS = [
    "src/pages/api/consignment/import/manifest.ts",
    "src/pages/api/consignment/import/consignment-items.ts",
    "src/pages/api/consignment/import/payment-lines.ts",
  ];

  it("no consignment import creates a vendor", () => {
    // The behaviour that produced duplicate suppliers. A manifest imported
    // before anyone set the vendor up used to quietly mint one.
    for (const rel of CREATORS) {
      const code = codeOf(readFileSync(join(APP, rel), "utf8"));
      expect(code).not.toMatch(/vendor\.(create|upsert)\(/);
    }
  });

  it("each one resolves by flag and refuses when none is configured", () => {
    for (const rel of CREATORS) {
      const code = codeOf(readFileSync(join(APP, rel), "utf8"));
      expect(code).toContain("getPrimaryConsignmentVendorId");
      expect(code).toMatch(/No consignment vendor configured/);
    }
  });
});
