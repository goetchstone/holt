// /app/__tests__/dbGuardsCoverage.test.ts
//
// Every database-level guard defined in a migration must also be in
// prisma/testing/db-guards.sql, or it does not exist in the integration test
// database and nothing can test it.
//
// The gap this closes, found the hard way: jest.integration.setup.ts builds the
// test schema with `prisma db push`, which applies schema.prisma and NOTHING
// else. Triggers, trigger functions and raw-SQL CHECK constraints all live in
// migration SQL, so none of them existed in the test DB. An integration test
// asserting the payment append-only trigger fires watched the DELETE succeed --
// which is exactly the false confidence a missing guard produces: the test that
// would have caught a dropped trigger passes whether or not the trigger is
// there.
//
// Three guards were affected, and they are not minor:
//   payment_delete_immutability                 payments are append-only
//   JournalEntry_balanced_check                 debits must equal credits
//   ImportDefinition_reconcile_requires_runner  RECONCILE needs a runner
//
// This test is deliberately about NAMES, not SQL equivalence. Comparing
// statement text would break on whitespace and teach people to silence it.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Whole-identifier match, never a substring.
 *
 * `guards.includes(name)` looked right and was not: renaming a guard to
 * `JournalEntry_balanced_check_RENAMED` still CONTAINS the original name, so a
 * probe that dropped the guard sailed through. SQL identifiers can be adjacent
 * to quotes, whitespace or parens, so the boundary is "not a word character".
 */
function declaresIdentifier(sql: string, name: string): boolean {
  return new RegExp(`(^|[^\\w])${name}([^\\w]|$)`).test(sql);
}

const APP_DIR = join(__dirname, "..");
const MIGRATIONS = join(APP_DIR, "prisma", "migrations");
const GUARDS = join(APP_DIR, "prisma", "testing", "db-guards.sql");

/** Trigger names and CHECK-constraint names declared anywhere in migrations. */
function guardsDeclaredInMigrations(): { triggers: string[]; checks: string[] } {
  const triggers = new Set<string>();
  const checks = new Set<string>();
  if (!existsSync(MIGRATIONS)) return { triggers: [], checks: [] };

  for (const dir of readdirSync(MIGRATIONS)) {
    const file = join(MIGRATIONS, dir, "migration.sql");
    if (!existsSync(file)) continue;
    const sql = readFileSync(file, "utf8");
    for (const m of sql.matchAll(/CREATE\s+TRIGGER\s+"?(\w+)"?/gi)) triggers.add(m[1]);
    // Only CHECK constraints. A FOREIGN KEY constraint is part of
    // schema.prisma and `db push` creates it, so it is not a guard this file
    // has to carry.
    for (const m of sql.matchAll(/ADD\s+CONSTRAINT\s+"([^"]+)"\s+CHECK/gi)) checks.add(m[1]);
  }
  return { triggers: [...triggers].sort(), checks: [...checks].sort() };
}

describe("database guards reach the integration test DB", () => {
  it("the guards file exists — without it the harness applies nothing", () => {
    expect(existsSync(GUARDS)).toBe(true);
  });

  it("every trigger declared in a migration is carried by the guards file", () => {
    const guards = readFileSync(GUARDS, "utf8");
    const missing = guardsDeclaredInMigrations().triggers.filter(
      (t) => !declaresIdentifier(guards, t),
    );
    expect(missing).toEqual([]);
  });

  it("every CHECK constraint declared in a migration is carried by the guards file", () => {
    const guards = readFileSync(GUARDS, "utf8");
    const missing = guardsDeclaredInMigrations().checks.filter(
      (c) => !declaresIdentifier(guards, c),
    );
    expect(missing).toEqual([]);
  });

  it("the harness actually applies the file", () => {
    // A guards file nothing runs is worse than no file: it reads as coverage.
    const setup = readFileSync(join(APP_DIR, "jest.integration.setup.ts"), "utf8");
    expect(setup).toMatch(/applyDbGuards\(/);
    expect(setup).toContain("db-guards.sql");
  });

  it("finds the guards it was written for, so the scan is not silently empty", () => {
    // If the regexes stop matching, every "missing" list is empty and all the
    // assertions above pass while covering nothing.
    const { triggers, checks } = guardsDeclaredInMigrations();
    expect(triggers).toContain("payment_delete_immutability");
    expect(checks).toContain("JournalEntry_balanced_check");
    expect(checks).toContain("ImportDefinition_reconcile_requires_runner");
  });
});
