// /app/__tests__/taxResolutionSingleSource.test.ts
//
// Tax comes from the configured district. Not from a literal, and not from the
// client.
//
// Two failure shapes this pins, both of which were live in this codebase:
//
//   A RATE LITERAL. `vatRate: isTaxExempt ? 0 : <one state's rate>` in the B2B
//   proposal-conversion path — one deployment's state rate compiled into the
//   product, charging every other deployment's customers that state's tax.
//   It is the same family as the hardcoded single-state district lookup that
//   lib/tax/resolveTaxRate.ts was written to replace.
//
//   A CLIENT-SUPPLIED RATE. `const { taxRate } = req.body` on the add-line-item
//   route, then `vatRate: taxRate || 0`. A caller could send any rate, and a
//   caller that omitted it got a line silently added at ZERO tax to an
//   otherwise-taxed order.
//
// A route that WRITES vatRate must resolve it through lib/tax/resolveTaxRate.
// Reading vatRate back to display or to copy an existing line is not writing a
// new rate and is not covered here.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const APP_DIR = join(__dirname, "..");

/**
 * Source with comments removed.
 *
 * Every one of these checks is about what the CODE does, and every file here
 * explains the bug it used to have -- including by quoting the literal. A
 * substring scan over raw source flags those explanations and the guard dies of
 * false positives, which is how a tripwire gets deleted rather than fixed.
 */
function codeOf(rel: string): string {
  return readFileSync(join(APP_DIR, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/([^:])\/\/.*$/gm, "$1");
}

/**
 * Files that write a vatRate WITHOUT resolving it, each with a reason.
 *
 * Every entry copies a rate that already exists on the row it is
 * amending — the tax on a sold line is a recorded fact and must not silently
 * re-rate itself because a district was edited afterwards.
 */
const COPIES_AN_EXISTING_RATE: Record<string, string> = {
  "src/pages/api/sales/orders/[id]/line-items/[lineItemId].ts":
    "Replacement/edit of an existing line reuses that line's own vatRate — the rate charged at sale time is a recorded fact, not something to re-derive later.",
  "src/lib/returns/bookReturn.ts":
    "A native return's own order reverses the original line at the rate that line was sold at (it selects `vatRate: true` and copies it) — re-resolving would refund a different tax than was charged.",
};

/** Rate literals that are never a tax rate. 0 and 1 are identity values. */
const ALLOWED_NUMERIC = /^(0|1|0\.0|1\.0)$/;

function filesWriting(pattern: string): string[] {
  try {
    return execFileSync("grep", ["-rl", pattern, "src", "--include=*.ts"], {
      cwd: APP_DIR,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.includes("__tests__"))
      .sort();
  } catch (err: unknown) {
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

describe("tax rate is resolved, never hardcoded or client-supplied", () => {
  it("every route that writes vatRate resolves it through lib/tax", () => {
    const offenders = filesWriting("vatRate:")
      .filter((f) => !(f in COPIES_AN_EXISTING_RATE))
      .filter((f) => {
        const src = codeOf(f);
        if (/resolveTaxDistrict|rateForLineAmount/.test(src)) return false;
        // A file that only ever writes vatRate: <existing value> is reading,
        // not deciding. Anything else is deciding a rate without the resolver.
        const writes = src.match(/vatRate:\s*([^,\n]+)/g) ?? [];
        return writes.some((w) => {
          const value = w.replace(/^vatRate:\s*/, "").trim();
          if (ALLOWED_NUMERIC.test(value)) return false;
          return !/vatRate|item\.|lineItem\.|li\./.test(value);
        });
      });

    expect(offenders).toEqual([]);
  });

  it("no decimal tax-rate literal survives outside the resolver and its tests", () => {
    // A specific state's rate was once compiled in. Any bare rate literal in a
    // vatRate write path is the same bug wearing a different number.
    const RATE_LITERAL_WRITE = /vatRate:[^,\n]*?(?<![\w.])0?\.\d*[1-9]/;
    // The pattern must be able to disagree: it catches the historical shape and
    // passes the identity values and copied rates.
    expect(RATE_LITERAL_WRITE.test("vatRate: isTaxExempt ? 0 : 0.065")).toBe(true);
    expect(RATE_LITERAL_WRITE.test("vatRate: 0.0")).toBe(false);
    expect(RATE_LITERAL_WRITE.test("vatRate: item.vatRate")).toBe(false);

    const hits = filesWriting("vatRate:")
      .filter((f) => !f.startsWith("src/lib/tax/"))
      .filter((f) => RATE_LITERAL_WRITE.test(codeOf(f)));
    expect(hits).toEqual([]);
  });

  it("no route APPLYING tax reads the rate off the request body", () => {
    // Scoped to routes that write a line's vatRate. The TaxRule admin CRUD
    // (pages/api/tax/rules/*) legitimately takes taxRate from the body -- that
    // is an operator CONFIGURING the rate, which is the entire point of the
    // config system. Configuring a rate and applying one to a sale are
    // different acts, and only the second must never trust the client.
    const offenders = filesWriting("vatRate:").filter((f) =>
      /\btaxRate\b[\s\S]{0,400}?=\s*req\.body/.test(codeOf(f)),
    );
    expect(offenders).toEqual([]);
  });

  it("every exemption entry names a real file", () => {
    const present = new Set(filesWriting("vatRate:"));
    for (const f of Object.keys(COPIES_AN_EXISTING_RATE)) expect(present.has(f)).toBe(true);
  });

  it("every order written from a resolved district also records the customer's exemption", () => {
    // Tax Summary files an exempt sale under its order's taxExemptReasonId. A
    // route that writes `taxDistrictId: <resolved>.taxDistrictId` and not the
    // reason beside it charges the exempt customer 0% and then reports the sale
    // as a taxable one in that district. Before 2026-10-29 every native route
    // did exactly that. Behaviour is pinned per route in
    // integration/taxExemption.integration.test.ts; this catches the next one.
    function unrecorded(code: string): string[] {
      const missing: string[] = [];
      const districtWrites = [...code.matchAll(/taxDistrictId:\s*(\w+)\.taxDistrictId\b/g)];
      const byVar = new Map<string, number>();
      for (const m of districtWrites) byVar.set(m[1], (byVar.get(m[1]) ?? 0) + 1);
      for (const [v, n] of byVar) {
        const reasons = code.match(
          new RegExp(`taxExemptReasonId:\\s*${v}\\.taxExemptReasonId\\b`, "g"),
        );
        if ((reasons?.length ?? 0) < n) missing.push(v);
      }
      return missing;
    }
    // Able to disagree: a district write alone fails, the pair passes.
    expect(unrecorded("data: { taxDistrictId: td.taxDistrictId, x: 1 }")).toEqual(["td"]);
    expect(
      unrecorded("{ taxDistrictId: td.taxDistrictId, taxExemptReasonId: td.taxExemptReasonId }"),
    ).toEqual([]);

    const callers = filesWriting("resolveTaxDistrict(").filter(
      (f) => !f.startsWith("src/lib/tax/"),
    );
    // The population is real: the register's own route is in it.
    expect(callers).toContain("src/pages/api/sales/orders/create-from-cart.ts");
    const offenders = callers.filter((f) => unrecorded(codeOf(f)).length > 0);
    expect(offenders).toEqual([]);
  });
});
