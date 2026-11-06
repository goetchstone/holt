// /app/__tests__/auditCoverage.test.ts
//
// A manifest and a tripwire (rule 65) for the audit trail, GAP-29. A guard on one
// path is no guard (rule 42): an action nobody recorded looks just like one nobody
// did. So every event in the catalog must have somewhere that records it, and every
// route of a sensitive shape must record something or say here why not.
//
// Source text is right for this class ("this must exist everywhere", rule 57). What
// each route records is tested for real in integration/auditTrail.integration.test.ts.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_EVENTS, type AuditEvent } from "@/lib/auditCatalog";
import { auditFilterFrom, auditTargetHref } from "@/lib/auditFeed";
import { changedFieldNames } from "@/lib/audit";

const APP = join(__dirname, "..");
const API = "src/pages/api";

function filesUnder(dir: string): string[] {
  return readdirSync(join(APP, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    if (statSync(join(APP, path)).isDirectory()) return filesUnder(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const read = (file: string) => readFileSync(join(APP, file), "utf8");

/** The shapes of route that move money, access, price or data, or destroy something. */
const SENSITIVE: RegExp[] = [
  /\/(delete-all|merge-duplicates|merge|bulk-reset-missing)\.ts$/,
  /\/clear-[a-z-]+\.ts$/,
  /^src\/pages\/api\/pricing\/import\//,
  /^src\/pages\/api\/admin\/roles\//,
  /^src\/pages\/api\/staff\/(index|\[id\])\.ts$/,
  /^src\/pages\/api\/admin\/staff\//,
  /^src\/pages\/api\/tax\//,
  /^src\/pages\/api\/tenders\//,
  /^src\/pages\/api\/admin\/database\//,
  /^src\/pages\/api\/exports\//,
  /\/export(-[a-z]+)?\.ts$/,
  /\/export\/[^/]+\.ts$/,
  /\/email-list\.ts$/,
  /^src\/pages\/api\/admin\/settings\/(index|integrations)\.ts$/,
  /^src\/pages\/api\/admin\/impersonate\.ts$/,
  /^src\/pages\/api\/admin\/automations\/\[key\]\.ts$/,
  /^src\/pages\/api\/admin\/reports\/commission-tiers\/tiers\.ts$/,
];

/** Fits a shape above and records nothing, on purpose. The reason is required. */
const NOT_RECORDED: Record<string, string> = {
  "src/pages/api/pricing/import/wholesale-prices.ts":
    "Recorded by lib/pricing/importWholesaleBook.ts, which does the import.",
  "src/pages/api/admin/buyer-drafts/export/items.ts":
    "A buyer's own draft items, for a vendor: no customer or sales data.",
  "src/pages/api/admin/buyer-drafts/export/pos.ts":
    "A buyer's own draft POs, for a vendor: no customer or sales data.",
  "src/pages/api/admin/buyer-drafts/export/workbook.ts":
    "A buyer's own draft workbook, for a vendor: no customer or sales data.",
  "src/pages/api/admin/config/presets/export.ts":
    "Reads out the store's own configuration; applying a preset is what's recorded.",
  "src/pages/api/reports/traffic/export.ts": "Door counts: nobody's personal or financial data.",
};

describe("the audit trail's coverage", () => {
  const source = filesUnder("src").filter((file) => !file.startsWith("src/lib/audit"));
  const sensitive = filesUnder(API).filter((file) => SENSITIVE.some((shape) => shape.test(file)));

  it("finds the routes it's meant to, so the shapes above can't quietly match nothing", () => {
    expect(sensitive.length).toBeGreaterThan(30);
    expect(sensitive).toContain("src/pages/api/customers/delete-all.ts");
    expect(sensitive).toContain("src/pages/api/admin/database/backup.ts");
  });

  it("has somewhere that records every event in the catalog", () => {
    const text = source.map(read).join("\n");
    const unrecorded = (Object.keys(AUDIT_EVENTS) as AuditEvent[]).filter(
      (event) => !text.includes(`"${event}"`),
    );
    expect(unrecorded).toEqual([]);
  });

  it("records something in every sensitive route, or says why not", () => {
    const silent = sensitive.filter(
      (file) => !read(file).includes("auditLog(") && !NOT_RECORDED[file],
    );
    expect(silent).toEqual([]);
  });

  it("has the wholesale import record itself, as its route's reason says", () => {
    expect(read("src/lib/pricing/importWholesaleBook.ts")).toContain('auditLog("PRICES_IMPORTED"');
  });

  it("has no stale reason: each names a real route that still records nothing", () => {
    for (const [file, reason] of Object.entries(NOT_RECORDED)) {
      expect(reason.length).toBeGreaterThan(0);
      expect(existsSync(join(APP, file))).toBe(true);
      expect(read(file)).not.toContain("auditLog(");
    }
  });
});

describe("reading the filter from a URL", () => {
  it("leaves out what it can't read rather than refusing", () => {
    expect(
      auditFilterFrom({
        who: " pat ",
        group: "nope",
        from: "yesterday",
        to: "2026-13-45",
        page: "-2",
      }),
    ).toEqual({ who: "pat", group: null, fromDay: "", toDay: "", page: 1 });
  });

  it("keeps what it can", () => {
    expect(
      auditFilterFrom({
        who: "pat",
        group: "prices",
        from: "2026-11-01",
        to: "2026-11-06",
        page: "3",
      }),
    ).toEqual({ who: "pat", group: "prices", fromDay: "2026-11-01", toDay: "2026-11-06", page: 3 });
  });

  it("takes the first of a repeated value", () => {
    expect(auditFilterFrom({ who: ["pat", "sam"] }).who).toBe("pat");
  });
});

describe("what an entry links to", () => {
  it.each([
    ["order", "src/app/(dashboard)/app/sales/orders/[id]/page.tsx"],
    ["customer", "src/app/(dashboard)/app/sales/customers/[id]/page.tsx"],
    ["product", "src/app/(dashboard)/app/inventory/products/[id]/page.tsx"],
    ["staff", "src/app/(dashboard)/app/admin/staff/page.tsx"],
    ["role", "src/app/(dashboard)/app/admin/setup/roles/page.tsx"],
  ])("%s opens a page that exists", (type, page) => {
    expect(auditTargetHref(type, "7")).toMatch(/^\/app\//);
    expect(existsSync(join(APP, page))).toBe(true);
  });

  it("links nothing when it has nothing to link", () => {
    expect(auditTargetHref(null, "7")).toBeNull();
    expect(auditTargetHref("order", null)).toBeNull();
    expect(auditTargetHref("vendor", "7")).toBeNull();
  });
});

describe("which fields changed", () => {
  it("names what differs, and not what's the same", () => {
    expect(changedFieldNames({ a: 1, b: "x" }, { a: 2, b: "x" })).toEqual(["a"]);
  });

  it("doesn't call a Decimal read back as text a change", () => {
    expect(changedFieldNames({ rate: "1.5" }, { rate: 1.5 })).toEqual([]);
  });

  it("treats a field left out as no change, and clearing one as a change", () => {
    expect(changedFieldNames({ a: 1 }, { a: undefined })).toEqual([]);
    expect(changedFieldNames({ a: 1 }, { a: null })).toEqual(["a"]);
  });

  it("compares structured values", () => {
    expect(changedFieldNames({ a: { x: 1 } }, { a: { x: 1 } })).toEqual([]);
    expect(changedFieldNames({ a: { x: 1 } }, { a: { x: 2 } })).toEqual(["a"]);
  });
});
