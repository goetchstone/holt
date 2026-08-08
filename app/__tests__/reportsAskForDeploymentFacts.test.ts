// /app/__tests__/reportsAskForDeploymentFacts.test.ts
//
// holt began as one company's system. That shows up most clearly in
// lib/reports/, where — before lib/reports/businessDay.ts — NOT ONE of the 36
// modules read app settings. A report had no way to ask "what does this
// business do", so every deployment fact it needed became a literal in the
// file: the freight product names, the department taxonomies, the tax rate, the
// timezone. One missing channel producing a dozen findings, not a dozen lapses.
//
// The channel exists now (getAppSettings, with businessDay.ts as its first
// consumer). This is the guard that keeps it used.
//
// WHY THIS FILE IS SO SMALL. The first draft also asserted "no hardcoded tax
// rate" and "no UTC", and both were wrong: `0\.0[0-9]{2,3}` matches the
// timestamp literal `T00:00:00.000Z`, and `UTC` matches `Date.UTC()` and
// `getUTCFullYear()` — legitimate everywhere. A guard that fires on correct
// code gets muted, and a muted guard protects nothing.
//
// The two tripwires in this repo that work (dependency overrides, revenue
// statuses) work because they compare against the lockfile or match an exact
// literal — never because they were clever. So this asserts only the one thing
// that can be asserted exactly, and pins the rest by name for human review.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

const APP_DIR = join(__dirname, "..");

function grepReports(pattern: string): string[] {
  try {
    const out = execFileSync("grep", ["-rnF", pattern, "src/lib/reports"], {
      cwd: APP_DIR,
      encoding: "utf8",
    });
    return out.trim().split("\n").filter(Boolean);
  } catch {
    // grep exits 1 on no match, which is the passing case.
    return [];
  }
}

/** Comment lines hardcode nothing — businessDay.ts explains the bug in prose. */
function codeOnly(lines: string[]): string[] {
  return lines.filter((l) => {
    const after = l.split(":").slice(2).join(":").trim();
    return !after.startsWith("//") && !after.startsWith("*") && !after.startsWith("/*");
  });
}

describe("the reports layer asks for deployment facts instead of hardcoding them", () => {
  it("contains no IANA timezone literal — the business day comes from AppSettings", () => {
    // Zero violations today, so this is pure prevention with nothing to
    // grandfather, and an IANA zone name cannot appear in correct report code
    // by accident.
    //
    // The bug it prevents: salesDaily grouped by the UTC calendar date, so a
    // sofa sold at 8pm Eastern was reported on the following day. The timezone
    // was never unknown — AppSettings.timezone already existed, was already in
    // the admin UI, and was already read by the blog and by email. The reports
    // simply never asked.
    const offenders = [
      ...codeOnly(grepReports("America/")),
      ...codeOnly(grepReports("Europe/")),
      ...codeOnly(grepReports("Asia/")),
      ...codeOnly(grepReports("Australia/")),
    ];
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Known taxonomy debt, pinned by name rather than detected.
//
// These three carry one business's vocabulary. No regex can reliably separate
// those strings from domain vocabulary — "Rugs" and "ORDER" look identical to a
// pattern — so they are listed. A NEW report hardcoding a taxonomy is caught by
// review; these stay visible and counted rather than quietly normal.
//
// When a taxonomy preset lands (docs/tenant-literal-sweep.md), the assertions
// below start failing, and that failure is the signal to delete them. Shrinking
// this list is the measure of progress.
// ---------------------------------------------------------------------------
describe("taxonomy debt is counted, not hidden", () => {
  it("crossSell still hardcodes one shop's departments", () => {
    // TARGET_DEPTS, plus a 'Furniture' anchor inside the raw SQL, plus
    // neverRugs / neverCurtains baked into the RESULT TYPE — so one shop's
    // departments sit in the API contract, not merely in a config value.
    expect(grepReports('"Outdoor Furniture"').length).toBeGreaterThan(0);
  });

  it("designerDashboard still hardcodes one shop's categories", () => {
    // CATEGORY_DEPARTMENT_MAP, EXCLUDED_DEPARTMENTS, CATEGORIES.
    expect(grepReports('"Window Treatments"').length).toBeGreaterThan(0);
  });

  it("wealthInsights still hardcodes a fixed customer-tier ladder", () => {
    expect(grepReports('"VIP"').length).toBeGreaterThan(0);
  });
});
