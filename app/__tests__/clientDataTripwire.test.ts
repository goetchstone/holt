// /app/__tests__/clientDataTripwire.test.ts
//
// A real client's data must never enter this repository. It once did: a
// retailer's production data reached it as test fixtures (staff and customer
// names, contact details, its domain, store and town names, vendors'
// confidential dealer pricing), was public, and forced a fresh repository.
// This test is what stops it coming back.
//
// It exists because the failure is silent and asymmetric. Committing a real
// customer's name breaks no test, blocks no build, and looks exactly like the
// invented fixture beside it -- but once pushed it is in the history, and no
// later commit takes it back.
//
// WHERE THE PATTERNS LIVE. Not in the repository. A guard listing a real
// business's surnames, towns, ZIP and phone numbers is itself a
// re-identification kit, and base64 did not change that (it was the previous
// design). The list is read from, in order:
//   1. the CLIENT_DATA_PATTERNS environment variable (a GitHub Actions secret
//      in CI), holding the JSON below;
//   2. config/local/client-data-patterns.json, which is gitignored.
// Shape: [{ "p": "<base64 of the regex source>", "what": "<plain-English reason>" }].
// In CI a missing list FAILS, so the gate cannot pass by finding nothing to
// check. Locally, with no list, the scan is skipped and says so.
//
// To add a pattern, base64 the regex and append { p, what } to the local file
// and to the secret:
//   node -e 'process.stdout.write(Buffer.from("your-regex").toString("base64"))'
//
// SCOPE, deliberately narrow. This scans for the specific identifiers already
// found, not for "PII" in general -- an open-ended heuristic would flag
// invented fixtures constantly and get silenced, which is worse than no test.
// When a new deployment's data lands, add ITS identifiers.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");

/**
 * Identifiers belonging to a real business or a real person. `p` is a
 * base64-encoded regex source, matched case-insensitively against every tracked
 * and untracked-but-not-ignored file, and against every path.
 *
 * Anything added must be genuinely identifying. A generic word that merely
 * appears in one deployment's data does not belong -- it would fire on ordinary
 * code and train people to add exemptions rather than fix leaks.
 */
type Forbidden = { p: string; what: string };

const PATTERN_FILE = join(REPO_ROOT, "config", "local", "client-data-patterns.json");

function loadForbidden(): Forbidden[] | null {
  const raw = process.env.CLIENT_DATA_PATTERNS?.trim()
    ? process.env.CLIENT_DATA_PATTERNS
    : existsSync(PATTERN_FILE)
      ? readFileSync(PATTERN_FILE, "utf8")
      : null;
  if (raw === null) return null;
  const list = JSON.parse(raw) as Forbidden[];
  if (!Array.isArray(list) || list.length === 0 || list.some((f) => !f.p || !f.what)) {
    throw new Error("client-data patterns must be a non-empty [{ p, what }] list");
  }
  return list;
}

const FORBIDDEN = loadForbidden();

const decode = (p: string) => Buffer.from(p, "base64").toString("utf8");

/**
 * Files allowed to contain a hit, each with the reason it cannot be scrubbed.
 *
 * A path here is a standing exception, so the reason has to be a real
 * constraint -- "it's only a comment" is not one. Empty since 2026-10-03: the
 * two applied migrations that were listed had only comments, and editing an
 * applied migration's comment does not stop `prisma migrate deploy` or
 * `migrate status` (checked on a scratch database), so they were scrubbed.
 */
const ALLOWED: Record<string, string> = {};

function trackedHits(pattern: string): { file: string; line: string }[] {
  let out = "";
  try {
    out = execFileSync("git", ["grep", "-niE", "--untracked", pattern, "--", "."], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    // git grep exits 1 with no output when nothing matches -- that is the pass.
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

if (FORBIDDEN === null) {
  if (process.env.CI) {
    it("has its client-data patterns (set the CLIENT_DATA_PATTERNS secret)", () => {
      throw new Error(
        "No client-data patterns: CI must provide CLIENT_DATA_PATTERNS, or the tripwire checks nothing.",
      );
    });
  } else {
    it.skip("client-data tripwire: no local patterns (config/local/client-data-patterns.json)", () => {});
  }
}

const describeWithPatterns = FORBIDDEN === null ? describe.skip : describe;

describeWithPatterns("no real client or personal data in the repository", () => {
  // A positive control, and the first test on purpose. Every other assertion
  // here passes when the scan returns nothing -- so a scan that silently
  // reaches nothing at all reads as a spotless repo. This one fails instead.
  // It replaced an earlier trick where the test file matched its own plaintext
  // patterns; encoding them removed that accident, so the canary is now
  // deliberate.
  it("actually scans the repository", () => {
    expect(trackedHits("assertSafeSeedTarget").length).toBeGreaterThan(0);
    expect(pathHits("clientDataTripwire").length).toBeGreaterThan(0);
  });

  for (const { p, what } of FORBIDDEN ?? []) {
    it(`does not contain ${what}`, () => {
      const pattern = decode(p);
      const unexplained = [...trackedHits(pattern), ...pathHits(pattern)].filter(
        (h) => !(h.file in ALLOWED),
      );
      expect(unexplained.map((h) => h.line)).toEqual([]);
    });
  }

  // The exemption list is the part that rots: a file gets scrubbed or deleted,
  // its entry stays, and the next real hit in a path someone copied from it
  // passes silently. Checking BOTH directions is what makes the list
  // trustworthy.
  it("has no stale exemptions -- every allowed path still has a hit to explain", () => {
    const allHits = new Set(
      (FORBIDDEN ?? []).flatMap(({ p }) => trackedHits(decode(p))).map((h) => h.file),
    );
    expect(Object.keys(ALLOWED).filter((f) => !allHits.has(f))).toEqual([]);
  });
});
