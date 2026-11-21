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
//
// That error is a 404 saying what to set, answered by one shared check before a
// route starts work (consignmentVendorOr404, rule 42). Four imports threw it
// from inside their transaction instead, so it reached the caller only as the
// body of a 500, the status of a fault, which a 500 may no longer carry (rule
// 11). The routes against a real database:
// __tests__/integration/consignmentVendorRefusal.integration.test.ts.

import type { NextApiResponse } from "next";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { consignmentVendorOr404, NO_CONSIGNMENT_VENDOR } from "@/lib/consignmentVendor";

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
const ALLOWED = new Set(["src/lib/adapters/legacyPos/reportRouter.ts"]);

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
      expect(code).toContain("consignmentVendorOr404(");
    }
  });
});

/**
 * Stands in for the client: the vendors flagged isConsignment, and what was
 * asked. As a database does, it answers rows in the order they are stored
 * (`ids`) unless the query asks for an order by id.
 */
function flagged(ids: number[]) {
  const asked: unknown[] = [];
  const client = {
    vendor: {
      findMany: async (args: { orderBy?: { id?: "asc" | "desc" } }) => {
        asked.push(args);
        const rows = ids.map((id) => ({ id }));
        const order = args.orderBy?.id;
        if (order) rows.sort((a, b) => (order === "asc" ? a.id - b.id : b.id - a.id));
        return rows;
      },
    },
  };
  return { client: client as unknown as Parameters<typeof consignmentVendorOr404>[0], asked };
}

function recorder() {
  const sent = { status: 0, body: undefined as unknown };
  const res = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(body: unknown) {
      sent.body = body;
      return res;
    },
  };
  return { res: res as unknown as NextApiResponse, sent };
}

describe("consignmentVendorOr404", () => {
  it("answers 404 with what to set, and returns null, when no vendor consigns", async () => {
    const { client } = flagged([]);
    const { res, sent } = recorder();
    expect(await consignmentVendorOr404(client, res)).toBeNull();
    expect(sent).toEqual({ status: 404, body: { error: NO_CONSIGNMENT_VENDOR } });
  });

  it("returns the consigning vendor, lowest id first, and answers nothing", async () => {
    // Stored with the higher id first, so only an order the query asks for gives 4.
    const { client, asked } = flagged([9, 4]);
    const { res, sent } = recorder();
    expect(await consignmentVendorOr404(client, res)).toBe(4);
    expect(sent).toEqual({ status: 0, body: undefined });
    expect(asked).toEqual([expect.objectContaining({ where: { isConsignment: true } })]);
  });
});

/**
 * Files that call getPrimaryConsignmentVendorId themselves and carry on without
 * a vendor, each with why. Every other route takes the vendor through
 * consignmentVendorOr404, so a deployment that does not consign is told so before
 * any work starts (rule 42). This sees only that call: a route that takes the
 * single vendor another way, such as getConsignmentVendorIds(...)[0] or a
 * vendor.findFirst on isConsignment, passes it.
 */
const CARRIES_ON_WITHOUT_ONE: Record<string, string> = {
  "src/pages/api/consignment/return-items.ts":
    "sends rugs back to the vendor without grouping them in a vendor-return record when none is flagged",
};

describe("one check for a deployment with no consignment vendor", () => {
  const files = walk(SRC).map((f) => relative(APP, f));

  it("every file calling getPrimaryConsignmentVendorId but the listed ones uses the check", () => {
    const direct = files.filter(
      (rel) =>
        rel !== "src/lib/consignmentVendor.ts" &&
        codeOf(readFileSync(join(APP, rel), "utf8")).includes("getPrimaryConsignmentVendorId("),
    );
    // Fails both ways: a new caller that skips the check, or a listed one that
    // no longer reads the vendor and should leave the list.
    expect(direct.sort()).toEqual(Object.keys(CARRIES_ON_WITHOUT_ONE).sort());
  });

  it("gives each listed caller its reason", () => {
    for (const reason of Object.values(CARRIES_ON_WITHOUT_ONE)) {
      expect(reason.trim().length).toBeGreaterThan(20);
    }
  });
});
