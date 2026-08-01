// app/prisma/seed/demo/guard.ts
//
// Target-database safety guard (CLAUDE.md rule 59: "fbc_test_db is the only
// database tests may write. saybrook, holt_saybrook, and akritos hold
// restored or seeded data and must never be written by a test or script.").
// This script writes thousands of rows outside a transaction, so it is even
// more dangerous than a test run against the wrong database -- there's no
// TRUNCATE-and-retry safety net. Refuse by default; require an explicit,
// separately-named opt-in for the "confirm-only" names, and never allow the
// hard-blocked one at all.
//
// This mirrors (but does not import) `src/lib/testing/withTestDb.ts`'s
// "DATABASE_URL must contain 'test'" pattern -- that guard protects the
// integration-test database from being targeted by something OTHER than
// the test harness. This guard protects the reverse case: a seed/demo
// script must never land on a database that holds real restored or curated
// data, or on the integration test database it doesn't own.

/**
 * Never allowed, no override. `fbc_test_db` is owned exclusively by the
 * Jest integration harness (jest.integration.setup.ts truncates and
 * migrates it per run) -- seeding thousands of rows into it outside that
 * harness's lifecycle would corrupt every integration test run until
 * someone notices.
 */
const HARD_BLOCKED_DB_NAMES = ["fbc_test_db"];

/**
 * Blocked unless the caller passes an explicit override. These hold
 * restored-from-backup or hand-curated data (saybrook / holt_saybrook /
 * akritos) or are the shared local dev database every `~/holt` session
 * points at (fbc_dev_db) -- clobbering any of them destroys real work with
 * no way back.
 */
const CONFIRM_BLOCKED_DB_NAMES = ["saybrook", "holt_saybrook", "akritos", "fbc_dev_db"];

export class UnsafeSeedTargetError extends Error {}

function extractDbName(databaseUrl: string): string {
  try {
    const u = new URL(databaseUrl);
    return u.pathname.replace(/^\//, "").split("?")[0];
  } catch {
    // Fall back to a manual parse if the URL constructor chokes on
    // something (shouldn't happen with a well-formed postgres:// URL).
    const afterSlash = databaseUrl.split("/").pop() ?? "";
    return afterSlash.split("?")[0];
  }
}

/** Strip credentials for safe logging -- same convention as
 * `withTestDb.ts`'s maskUrl(). */
export function maskDatabaseUrl(databaseUrl: string): string {
  return databaseUrl.replace(/:[^:@]+@/, ":****@");
}

export interface SafetyCheckOptions {
  /** True when --force-unsafe-db was passed or HOLT_SEED_FORCE_UNSAFE_DB=1
   * is set. Only lifts the CONFIRM_BLOCKED list -- never the hard block. */
  forceUnsafe: boolean;
}

/**
 * Throws `UnsafeSeedTargetError` unless `databaseUrl` points at a database
 * this script is explicitly allowed to write. Call this before any write
 * (including the reset TRUNCATE) -- there is no code path that should skip
 * it.
 */
export function assertSafeSeedTarget(databaseUrl: string, opts: SafetyCheckOptions): string {
  if (!databaseUrl) {
    throw new UnsafeSeedTargetError(
      "DATABASE_URL is not set. Point it at a scratch database created for this seed " +
        "(e.g. holt_seed_demo) before running.",
    );
  }
  const dbName = extractDbName(databaseUrl);
  const masked = maskDatabaseUrl(databaseUrl);

  if (HARD_BLOCKED_DB_NAMES.includes(dbName)) {
    throw new UnsafeSeedTargetError(
      `Refusing to seed database "${dbName}" (${masked}). This name is hard-blocked -- ` +
        `it is owned exclusively by the Jest integration-test harness and there is no ` +
        `override flag for it. Point DATABASE_URL at a scratch database instead (see ` +
        `docs/domains/seed-data.md).`,
    );
  }

  if (CONFIRM_BLOCKED_DB_NAMES.includes(dbName) && !opts.forceUnsafe) {
    throw new UnsafeSeedTargetError(
      `Refusing to seed database "${dbName}" (${masked}) without an explicit override. ` +
        `This name holds real dev/restored/seeded data (CLAUDE.md rule 59). If you are ` +
        `certain this is the intended target, re-run with --force-unsafe-db or ` +
        `HOLT_SEED_FORCE_UNSAFE_DB=1. Otherwise point DATABASE_URL at a scratch database ` +
        `created for this run (e.g. holt_seed_demo).`,
    );
  }

  return dbName;
}
