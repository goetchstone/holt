// /app/__tests__/seedTargetGuard.test.ts
//
// The seed writes thousands of rows outside a transaction, so the target check
// is the only thing between a mistyped DATABASE_URL and someone's real data.
// It had no test until this file.
//
// The guard used to be a BLOCKLIST of specific database names, which failed
// open -- a name nobody had listed seeded silently, and the list only grew
// after someone lost data. It is now an allowlist, so the cases below that
// matter most are the unfamiliar names: they must be refused precisely
// BECAUSE nobody thought of them.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assertSafeSeedTarget, UnsafeSeedTargetError } from "../prisma/seed/demo/guard";

const url = (db: string) => `postgresql://user:secret@localhost:5432/${db}`;
const safe = { forceUnsafe: false };
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const forced = { forceUnsafe: true };

describe("assertSafeSeedTarget", () => {
  it("allows a purpose-built scratch database", () => {
    for (const db of ["holt_seed_demo", "demo", "scratch_db", "holt_sandbox", "sample_data", "ci", "holt_ci"]) {
      expect(assertSafeSeedTarget(url(db), safe)).toBe(db);
    }
  });

  // The allowlist and the database CI actually creates are two facts that have
  // to agree, and nothing made them agree: the first version of this guard
  // refused CI's own database, which only surfaced after a push, in the one job
  // that boots the app. Reading the name out of the workflow closes that loop --
  // renaming the database in CI now fails here rather than in a remote build.
  it("accepts the database the CI workflow actually creates", () => {
    const workflow = readFileSync(join(__dirname, "..", "..", ".github", "workflows", "ci.yml"), "utf8");
    const names = [...workflow.matchAll(/^\s*POSTGRES_DB:\s*(\S+)\s*$/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const db of new Set(names)) {
      expect(() => assertSafeSeedTarget(url(db), safe)).not.toThrow();
    }
  });

  // setup.sh reimplements the same rule in shell so it can fail BEFORE running
  // migrations. Two implementations of one rule drift, so compare their
  // DECISIONS -- an earlier version of this test only checked that the shell
  // carried the same tokens, which it did while using substring globs (*demo*)
  // against the guard's word-bounded regex. That gap let setup.sh migrate and
  // seed roles into `holt_samples` before the seed refused it.
  it("makes exactly the same call as setup.sh, database by database", () => {
    const setup = readFileSync(join(__dirname, "..", "scripts", "setup.sh"), "utf8");
    const arm = setup.match(/^\s*((?:[A-Za-z0-9_*|]+\|)+[A-Za-z0-9_*|]+)\)\s*;;\s*$/m);
    expect(arm).not.toBeNull();
    const globs = arm![1].split("|");

    const shellAllows = (db: string) =>
      globs.some((g) => new RegExp("^" + g.split("*").map(escapeRe).join(".*") + "$").test(db));
    const guardAllows = (db: string) => {
      try {
        assertSafeSeedTarget(url(db), safe);
        return true;
      } catch {
        return false;
      }
    };

    // Names chosen to straddle the boundary in both directions: plurals,
    // hyphens, and tokens embedded in longer words are exactly where a
    // substring glob and a word-bounded regex part company.
    const NAMES = [
      "holt_demo", "holt_seed_demo", "demo", "ci", "holt_ci", "ci_main", "scratch_db",
      "holt_sandbox", "sample_data", "holt_samples", "holt-demo", "demolition_prod",
      "seeded_archive", "sandboxes", "scratchpad_prod", "holt_prod", "acme_restored",
      "postgres", "holt_2026_backup", "predemo", "demo_of_prod",
    ];
    const disagreements = NAMES.filter((db) => shellAllows(db) !== guardAllows(db)).map(
      (db) => `${db}: setup.sh=${shellAllows(db) ? "allow" : "refuse"} guard=${guardAllows(db) ? "allow" : "refuse"}`,
    );
    expect(disagreements).toEqual([]);
  });

  it("refuses an unfamiliar name -- the case a blocklist misses", () => {
    for (const db of ["holt_prod", "acme_restored", "holt_2026_backup", "postgres"]) {
      expect(() => assertSafeSeedTarget(url(db), safe)).toThrow(UnsafeSeedTargetError);
    }
  });

  it("lets an explicit override reach a non-scratch database", () => {
    expect(assertSafeSeedTarget(url("holt_prod"), forced)).toBe("holt_prod");
  });

  it("never allows the integration-test database, override or not", () => {
    expect(() => assertSafeSeedTarget(url("fbc_test_db"), safe)).toThrow(UnsafeSeedTargetError);
    expect(() => assertSafeSeedTarget(url("fbc_test_db"), forced)).toThrow(UnsafeSeedTargetError);
  });

  it("refuses an unset DATABASE_URL rather than defaulting somewhere", () => {
    expect(() => assertSafeSeedTarget("", safe)).toThrow(UnsafeSeedTargetError);
    expect(() => assertSafeSeedTarget("", forced)).toThrow(UnsafeSeedTargetError);
  });

  it("does not leak the password into the refusal message", () => {
    expect(() => assertSafeSeedTarget(url("holt_prod"), safe)).toThrow(/:\*\*\*\*@/);
    try {
      assertSafeSeedTarget(url("holt_prod"), safe);
    } catch (e) {
      expect((e as Error).message).not.toContain("secret");
    }
  });

  it("matches on the database name, not the rest of the URL", () => {
    // A host or user containing "demo" must not make a prod database look safe.
    expect(() => assertSafeSeedTarget("postgresql://demo:p@demo-host/holt_prod", safe)).toThrow(
      UnsafeSeedTargetError,
    );
    // Query parameters are not part of the name.
    expect(assertSafeSeedTarget(url("holt_seed_demo") + "?schema=public", safe)).toBe(
      "holt_seed_demo",
    );
  });
});
