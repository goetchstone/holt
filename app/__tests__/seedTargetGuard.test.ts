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

import { assertSafeSeedTarget, UnsafeSeedTargetError } from "../prisma/seed/demo/guard";

const url = (db: string) => `postgresql://user:secret@localhost:5432/${db}`;
const safe = { forceUnsafe: false };
const forced = { forceUnsafe: true };

describe("assertSafeSeedTarget", () => {
  it("allows a purpose-built scratch database", () => {
    for (const db of ["holt_seed_demo", "demo", "scratch_db", "holt_sandbox", "sample_data"]) {
      expect(assertSafeSeedTarget(url(db), safe)).toBe(db);
    }
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
