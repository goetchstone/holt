// /app/__tests__/clientDataTripwire.test.ts
//
// This repository is PUBLIC. It began as one retailer's internal system, and
// their production data leaked into it as test fixtures: staff and customer
// names, contact details, the company's own domain, its store and town names.
// That was scrubbed once. This test is what stops it coming back.
//
// It exists because the failure is silent and asymmetric. Committing a real
// customer's name breaks no test, blocks no build, and looks exactly like the
// invented fixture beside it -- but once pushed it is in the history and in
// every fork, and no later commit takes it back.
//
// SCOPE, deliberately narrow. This scans for the specific identifiers already
// found in this repo, not for "PII" in general -- an open-ended heuristic here
// would flag invented fixtures constantly and get silenced, which is worse than
// no test. When a new deployment's data lands, add ITS identifiers here.
//
// The one thing this test does NOT cover: the identifiers scrubbed at HEAD are
// still reachable in this repo's git history and in any existing fork. Removing
// them there means rewriting history, which is a separate decision.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");

/**
 * Identifiers belonging to a real business or a real person. Each is a regex
 * source, matched case-insensitively against every tracked file.
 *
 * Anything added here must be genuinely identifying. A generic word that merely
 * appears in one deployment's data does not belong -- it would fire on ordinary
 * code and train people to add exemptions.
 */
const FORBIDDEN: { pattern: string; what: string }[] = [
  // The STEM, not the full word. The codebase itself documents that the real
  // data carried typo variants of the domain, so a pattern matching only the
  // correct spelling would miss exactly the values that caused the incident the
  // email guard exists for.
  {
    pattern: "sayb",
    what: "the pilot deployment's company, town and email-domain stem, typos included",
  },
  { pattern: "cheshire|glastonbury", what: "the pilot deployment's store towns" },
  { pattern: "sammyg40|joneil|gstone|wcope", what: "real staff email local-parts" },
  { pattern: "greenstein|panagy|dransfield|matheny|tenerow", what: "real people's surnames" },
  { pattern: "sorbo|nordquist|calkins|barnum|homan|favale|vantongeren", what: "real people's surnames" },
  { pattern: "860-470-3653|213-623-1345|860-388-0891|860-388-3692", what: "real phone and fax numbers" },
  {
    pattern: "ciccone|dwyer|germano|filippone|levatino|sorbo|demik|sigal",
    what: "real people's surnames",
  },
  // Matched as whole names, because each of these surnames is far too common to
  // use on its own -- a bare "kelly" or "warren" would fire on ordinary code and
  // the entry would get deleted rather than fixed.
  {
    pattern:
      "erin kelly|alex robertson|rebecca warren|mary goodwin|reginald adams|madison baker|susan roberts|jamie young|sarah levatino|amy sage|shannon martin|lisa ritz",
    what: "real people's full names",
  },
  { pattern: "rwarren@|sammyg40", what: "real staff email local-parts" },
  { pattern: "57 princeton lane|298 highland avenue|2 main street|8 monticello|east lyme", what: "real street addresses" },
  { pattern: "06475", what: "the pilot deployment's town ZIP" },
  // Vendor dealer/wholesale pricing and the document numbers that tie a price
  // to a real order. Publishing another business's trade terms is the harm --
  // naming the vendor is not, which is why the brands themselves are absent here.
  {
    pattern:
      "PON090[0-9][0-9]|B31669979|153642-070126|1000292821|0063477|0063476|31680534|77234f1af6|0002592360|0002592361|18573341|18908185|32008813",
    what: "real vendor order, PO and document numbers",
  },
  {
    pattern:
      "10,976\\.49|32,108\\.67|1,057\\.62|1,188\\.57|22,373\\.00|2,688\\.00|3,322\\.00|2,196\\.00|722\\.74|2,368\\.50|9,?298\\.9|2,?484\\.65|352\\.54|53\\.94|107\\.88|24\\.75|39\\.99|1,?710\\.00|\\b285\\.00|\\b294\\.00|\\b396\\.00|\\b228\\.00|\\b688\\.00",
    what: "real vendor order totals and dealer prices",
  },
  { pattern: "costs top out at", what: "a disclosure of a vendor's catalog price ceiling" },
];

/**
 * Files allowed to contain a hit, each with the reason it cannot be scrubbed.
 *
 * A path here is a standing exception, so the reason has to be a real
 * constraint -- "it's only a comment" is not one. Prisma records a checksum of
 * every migration when it applies it, so editing an applied migration makes
 * `prisma migrate deploy` fail on every existing deployment until someone
 * resolves it by hand. That is a genuine reason; there is no other.
 */
const ALLOWED: Record<string, string> = {
  "app/prisma/migrations/20260806163000_stock_location_holds_committed_stock/migration.sql":
    "applied migration -- editing it breaks its Prisma checksum on live deployments",
  "app/prisma/migrations/20260806180000_app_settings_source_adapter/migration.sql":
    "applied migration -- editing it breaks its Prisma checksum on live deployments",
  "app/__tests__/clientDataTripwire.test.ts": "this file lists the patterns it searches for",
};

function trackedHits(pattern: string): { file: string; line: string }[] {
  let out = "";
  try {
    out = execFileSync("git", ["grep", "-niE", "--untracked", pattern, "--", "."], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    // git grep exits 1 with no output when nothing matches -- that is the pass.
    const err = e as { status?: number; stdout?: string };
    // Everything else must fail loud. A maxBuffer overflow in particular throws
    // with status null and TRUNCATED stdout: adopting that buffer would return a
    // partial walk that looks clean, which is the exact silent pass this test
    // exists to prevent.
    if (err.status === 1 && !err.stdout) return [];
    throw e;
  }
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ file: l.slice(0, l.indexOf(":")), line: l }));
}

/**
 * git grep matches CONTENT. A file whose contents are clean but whose NAME is a
 * client's still leaks, and so does a directory named after one.
 */
function pathHits(pattern: string): { file: string; line: string }[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const re = new RegExp(pattern, "i");
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => re.test(f))
    .map((f) => ({ file: f, line: `${f}: forbidden identifier in the PATH` }));
}

describe("no real client or personal data in a public repo", () => {
  for (const { pattern, what } of FORBIDDEN) {
    it(`does not contain ${what}`, () => {
      const unexplained = [...trackedHits(pattern), ...pathHits(pattern)].filter(
        (h) => !(h.file in ALLOWED),
      );
      expect(unexplained.map((h) => h.line)).toEqual([]);
    });
  }

  // The exemption list is the part that rots: a file gets scrubbed or deleted,
  // its entry stays, and the next real hit in a path someone copied from it
  // passes silently. Checking BOTH directions is what makes the list trustworthy.
  it("has no stale exemptions -- every allowed path still has a hit to explain", () => {
    const allHits = new Set(FORBIDDEN.flatMap(({ pattern }) => trackedHits(pattern)).map((h) => h.file));
    // This file is deliberately NOT exempted from the check. It always hits --
    // it contains the pattern sources themselves -- so it doubles as the
    // liveness canary: if the scan ever silently returns nothing, this is the
    // path that shows up stale and fails the test.
    const stale = Object.keys(ALLOWED).filter((f) => !allHits.has(f));
    expect(stale).toEqual([]);
  });
});
