// /app/__tests__/taxResolutionSingleSource.test.ts
//
// Tax comes from the configured district. Not from a literal, and not from the
// client.
//
// Two failure shapes this pins, both of which were live in this codebase:
//
//   A RATE LITERAL. `vatRate: isTaxExempt ? 0 : 0.0635` in the B2B
//   proposal-conversion path — one deployment's Connecticut rate compiled into
//   the product, charging every other deployment's customers Connecticut tax.
//   It is the same family as the `shortName: "CT"` district lookup that
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
 * Both current entries copy a rate that already exists on the row they are
 * amending — the tax on a sold line is a recorded fact and must not silently
 * re-rate itself because a district was edited afterwards.
 */
const COPIES_AN_EXISTING_RATE: Record<string, string> = {
  "src/pages/api/sales/orders/[id]/line-items/[lineItemId].ts":
    "Replacement/edit of an existing line reuses that line's own vatRate — the rate charged at sale time is a recorded fact, not something to re-derive later.",
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
    // 0.0635 is Connecticut. Any bare rate literal in a write path is the same
    // bug wearing a different number.
    const hits = filesWriting("0\\.0635")
      .filter((f) => !f.startsWith("src/lib/tax/"))
      .filter((f) => /0\.0635/.test(codeOf(f)));
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
});
