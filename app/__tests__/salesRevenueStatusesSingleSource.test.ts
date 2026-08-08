// /app/__tests__/salesRevenueStatusesSingleSource.test.ts
//
// `SALES_REVENUE_STATUSES` (lib/salesOrderRevenue.ts) is the one answer to "what
// counts as revenue". Before this test, 17 places answered it themselves with
// their own copy of ["ORDER", "FULFILLED", "RETURNED"] -- 14 inline Prisma
// filters plus three local constants named REVENUE_STATUSES, SALES_STATUSES and
// SOLD_STATUSES. `lib/commissionSales.ts` did it BOTH ways, fifty lines apart.
//
// None of that was broken, and that is the point: the values agreed, so nothing
// failed and nothing drew attention. The first change to the canonical list
// would have moved one site and left sixteen behind, silently, with no test to
// catch it -- CLAUDE.md rule 37's exact failure mode.
//
// salesOrderRevenue.ts's own header permits an inline copy in one case: when it
// is deliberately NARROWER, with a comment explaining why, "so future Sonar /
// grep audits can distinguish 'intentionally narrower' from 'forgot RETURNED'."
// This test is that audit. A narrower filter (e.g. ORDER + FULFILLED, excluding
// RETURNED) is not matched here and stays legal.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

const APP_DIR = join(__dirname, "..");

/** The canonical list's own definition. Nothing else may spell it out. */
const OWNER = "src/lib/salesOrderRevenue.ts";

/**
 * Raw-SQL sites still spell the triple inline as `IN ('ORDER', ...)`. A TS
 * constant cannot be dropped into a SQL string, so they need the SQL-fragment
 * half of the shared scope helper before they can be migrated. Listed here so
 * the debt is visible and counted rather than quietly excluded.
 */
const KNOWN_RAW_SQL_SITES = [
  "src/lib/customerLeveling.ts",
  "src/lib/reports/detailedSales.ts",
  "src/lib/reports/buyersReport.ts",
];

function grepTsTriple(): string[] {
  try {
    const out = execFileSync("grep", ["-rnF", '["ORDER", "FULFILLED", "RETURNED"]', "src"], {
      cwd: APP_DIR,
      encoding: "utf8",
    });
    return out.trim().split("\n").filter(Boolean);
  } catch {
    // grep exits 1 when it matches nothing, which is the passing case.
    return [];
  }
}

describe("SALES_REVENUE_STATUSES has exactly one definition", () => {
  it("no TypeScript file spells out the revenue triple except the file that owns it", () => {
    const offenders = grepTsTriple().filter((line) => !line.startsWith(OWNER));
    expect(offenders).toEqual([]);
  });

  it("the raw-SQL debt is exactly the files we know about — no new ones", () => {
    // Fails if someone adds a NEW raw-SQL copy, without pretending the existing
    // ones are fine. When the SQL fragment helper lands, this list goes to [].
    const out = execFileSync(
      "bash",
      [
        "-c",
        `grep -rn "IN ('ORDER', 'FULFILLED', 'RETURNED')\\|IN ('ORDER','FULFILLED','RETURNED')" src || true`,
      ],
      { cwd: APP_DIR, encoding: "utf8" },
    );
    const files = [
      ...new Set(
        out
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => l.split(":")[0]),
      ),
    ];
    expect(files.sort()).toEqual([...KNOWN_RAW_SQL_SITES].sort());
  });
});
