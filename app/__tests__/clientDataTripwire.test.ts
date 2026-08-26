// /app/__tests__/clientDataTripwire.test.ts
//
// This repository is PUBLIC. It began as one retailer's internal system, and
// their production data leaked into it as test fixtures: staff and customer
// names, contact details, the company's own domain, its store and town names,
// and several vendors' confidential dealer pricing. That was scrubbed. This
// test is what stops it coming back.
//
// It exists because the failure is silent and asymmetric. Committing a real
// customer's name breaks no test, blocks no build, and looks exactly like the
// invented fixture beside it -- but once pushed it is in the history and in
// every fork, and no later commit takes it back. It has already earned its
// keep twice: it found 57 mentions the first scrub missed, and it caught a
// name walking back in through a merge from another branch.
//
// WHY THE PATTERNS ARE BASE64 AND NOT PLAIN TEXT. A guard listing the exact
// surnames, towns, ZIP and phone numbers of a real business is itself the
// tidiest re-identification kit in the repo -- it would concentrate in one
// public file precisely what every other file was scrubbed of, and search
// engines index it. Encoding is not secrecy: anyone determined can decode it
// in a second. It stops the repo from being a plain-text index of a real
// company's identifying data, which is the actual harm. The guard works
// exactly as before.
//
// To add a pattern:
//   node -e 'process.stdout.write(Buffer.from("your-regex").toString("base64"))'
// and paste the result as `p`. Keep `what` in plain English -- the reason an
// entry exists must stay readable, only the identifier is encoded.
//
// SCOPE, deliberately narrow. This scans for the specific identifiers already
// found in this repo, not for "PII" in general -- an open-ended heuristic here
// would flag invented fixtures constantly and get silenced, which is worse
// than no test. When a new deployment's data lands, add ITS identifiers.
//
// The one thing this does NOT cover: the identifiers scrubbed at HEAD are
// still reachable in this repo's git history and in any existing fork.
// Removing them there means rewriting history, which is a separate decision.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");

/**
 * Identifiers belonging to a real business or a real person. `p` is a
 * base64-encoded regex source (see the header), matched case-insensitively
 * against every tracked and untracked-but-not-ignored file, and against every
 * path.
 *
 * Anything added here must be genuinely identifying. A generic word that merely
 * appears in one deployment's data does not belong -- it would fire on ordinary
 * code and train people to add exemptions rather than fix leaks.
 */
const FORBIDDEN: { p: string; what: string }[] = [
  {
    p: "c2F5Yg==",
    what: "the pilot deployment's company, town and email-domain stem, typos included",
  },
  { p: "Y2hlc2hpcmV8Z2xhc3RvbmJ1cnk=", what: "the pilot deployment's store towns" },
  { p: "c2FtbXlnNDB8am9uZWlsfGdzdG9uZXx3Y29wZQ==", what: "real staff email local-parts" },
  {
    p: "Z3JlZW5zdGVpbnxwYW5hZ3l8ZHJhbnNmaWVsZHxtYXRoZW55fHRlbmVyb3c=",
    what: "real people's surnames",
  },
  {
    p: "c29yYm98bm9yZHF1aXN0fGNhbGtpbnN8YmFybnVtfGhvbWFufGZhdmFsZXx2YW50b25nZXJlbg==",
    what: "real people's surnames",
  },
  {
    p: "ODYwLTQ3MC0zNjUzfDIxMy02MjMtMTM0NXw4NjAtMzg4LTA4OTF8ODYwLTM4OC0zNjky",
    what: "real phone and fax numbers",
  },
  {
    p: "Y2ljY29uZXxkd3llcnxnZXJtYW5vfGZpbGlwcG9uZXxsZXZhdGlub3xzb3Jib3xkZW1pa3xzaWdhbA==",
    what: "real people's surnames",
  },
  {
    p: "ZXJpbiBrZWxseXxhbGV4IHJvYmVydHNvbnxyZWJlY2NhIHdhcnJlbnxtYXJ5IGdvb2R3aW58cmVnaW5hbGQgYWRhbXN8bWFkaXNvbiBiYWtlcnxzdXNhbiByb2JlcnRzfGphbWllIHlvdW5nfHNhcmFoIGxldmF0aW5vfGFteSBzYWdlfHNoYW5ub24gbWFydGlufGxpc2Egcml0eg==",
    what: "real people's full names",
  },
  { p: "cndhcnJlbkB8c2FtbXlnNDA=", what: "real staff email local-parts" },
  {
    p: "NTcgcHJpbmNldG9uIGxhbmV8Mjk4IGhpZ2hsYW5kIGF2ZW51ZXwyIG1haW4gc3RyZWV0fDggbW9udGljZWxsb3xlYXN0IGx5bWU=",
    what: "real street addresses",
  },
  { p: "MDY0NzU=", what: "the pilot deployment's town ZIP" },
  {
    p: "UE9OMDkwWzAtOV1bMC05XXxCMzE2Njk5Nzl8MTUzNjQyLTA3MDEyNnwxMDAwMjkyODIxfDAwNjM0Nzd8MDA2MzQ3NnwzMTY4MDUzNHw3NzIzNGYxYWY2fDAwMDI1OTIzNjB8MDAwMjU5MjM2MXwxODU3MzM0MXwxODkwODE4NXwzMjAwODgxMw==",
    what: "real vendor order, PO and document numbers",
  },
  {
    p: "MTAsOTc2XFwuNDl8MzIsMTA4XFwuNjd8MSwwNTdcXC42MnwxLDE4OFxcLjU3fDIyLDM3M1xcLjAwfDIsNjg4XFwuMDB8MywzMjJcXC4wMHwyLDE5NlxcLjAwfDcyMlxcLjc0fDIsMzY4XFwuNTB8OSw/Mjk4XFwuOXwyLD80ODRcXC42NXwzNTJcXC41NHw1M1xcLjk0fDEwN1xcLjg4fDI0XFwuNzV8MzlcXC45OXwxLD83MTBcXC4wMHxcXGIyODVcXC4wMHxcXGIyOTRcXC4wMHxcXGIzOTZcXC4wMHxcXGIyMjhcXC4wMHxcXGI2ODhcXC4wMA==",
    what: "real vendor order totals and dealer prices",
  },
  { p: "Y29zdHMgdG9wIG91dCBhdA==", what: "a disclosure of a vendor's catalog price ceiling" },
];

const decode = (p: string) => Buffer.from(p, "base64").toString("utf8");

/**
 * Files allowed to contain a hit, each with the reason it cannot be scrubbed.
 *
 * A path here is a standing exception, so the reason has to be a real
 * constraint -- "it's only a comment" is not one. Prisma records a checksum of
 * every migration when it applies it, so editing an applied migration makes
 * `prisma migrate deploy` fail on every existing deployment until someone
 * resolves it by hand. That is a genuine reason; there is no other, which is
 * why this list is two entries long and both are migrations.
 */
const ALLOWED: Record<string, string> = {
  "app/prisma/migrations/20260806163000_stock_location_holds_committed_stock/migration.sql":
    "applied migration -- editing it breaks its Prisma checksum on live deployments",
  "app/prisma/migrations/20260806180000_app_settings_source_adapter/migration.sql":
    "applied migration -- editing it breaks its Prisma checksum on live deployments",
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

describe("no real client or personal data in a public repo", () => {
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

  for (const { p, what } of FORBIDDEN) {
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
      FORBIDDEN.flatMap(({ p }) => trackedHits(decode(p))).map((h) => h.file),
    );
    expect(Object.keys(ALLOWED).filter((f) => !allHits.has(f))).toEqual([]);
  });
});
