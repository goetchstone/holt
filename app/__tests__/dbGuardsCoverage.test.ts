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
/**
 * The guards file with its comment lines removed.
 *
 * The scan below asks "is this guard declared here", and a name mentioned in a
 * comment is not a declaration -- without this, documenting an excluded guard by
 * name would make it look carried. Only whole comment lines are dropped: `--`
 * also occurs inside the trigger's RAISE EXCEPTION message, and stripping from
 * any `--` would corrupt real code.
 */
function codeOf(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

function declaresIdentifier(sql: string, name: string): boolean {
  return new RegExp(`(^|[^\\w])${name}([^\\w]|$)`).test(sql);
}

const APP_DIR = join(__dirname, "..");
const MIGRATIONS = join(APP_DIR, "prisma", "migrations");
const GUARDS = join(APP_DIR, "prisma", "testing", "db-guards.sql");

/**
 * Guards knowingly NOT applied to the test database, each with why.
 *
 * An entry here is a gap, not an approval -- the guard still protects
 * production, it just is not exercised by the integration suite. The name must
 * appear in db-guards.sql alongside its reason so the omission is visible in
 * the file itself rather than only here.
 */
const EXCLUDED: Record<string, string> = {
  // Empty on purpose. JournalEntry_balanced_check lived here while the
  // dailyReconciliation fixtures still built unbalanced entries (#115); those
  // are fixed and the constraint is applied. Add an entry only with a reason,
  // which the test below enforces.
};

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
      (t) => !declaresIdentifier(codeOf(guards), t),
    );
    expect(missing).toEqual([]);
  });

  it("every CHECK constraint declared in a migration is carried by the guards file", () => {
    const guards = readFileSync(GUARDS, "utf8");
    const missing = guardsDeclaredInMigrations()
      .checks.filter((c) => !(c in EXCLUDED))
      .filter((c) => !declaresIdentifier(codeOf(guards), c));
    expect(missing).toEqual([]);
  });

  it("the harness actually applies the file", () => {
    // A guards file nothing runs is worse than no file: it reads as coverage.
    const setup = readFileSync(join(APP_DIR, "jest.integration.setup.ts"), "utf8");
    expect(setup).toMatch(/applyDbGuards\(/);
    expect(setup).toContain("db-guards.sql");
  });

  it("carries the trigger body VERBATIM from its migration", () => {
    // Names are not enough. My first version of the guards file had the right
    // NAMES and a hand-retyped function body that had lost `END IF;` and
    // `RETURN OLD;` -- valid-looking, and a syntax error the moment Postgres
    // parsed it. The name checks above passed the whole time.
    //
    // Comparing the block verbatim means the guards file can only be produced
    // by copying, not by retyping.
    const migration = readFileSync(
      join(MIGRATIONS, "20260428_payment_delete_immutability_trigger", "migration.sql"),
      "utf8",
    );
    const block = migration.match(
      /CREATE OR REPLACE FUNCTION enforce_payment_delete_immutability[\s\S]*?EXECUTE FUNCTION enforce_payment_delete_immutability\(\);/,
    );
    expect(block).not.toBeNull();
    expect(readFileSync(GUARDS, "utf8")).toContain(block![0]);
  });

  it("every exclusion is named in the guards file with its reason", () => {
    // An exclusion that lives only in this test is invisible to anyone reading
    // the SQL and wondering why a constraint is missing.
    const guards = readFileSync(GUARDS, "utf8");
    for (const name of Object.keys(EXCLUDED)) {
      expect(guards).toContain(name);
      expect(EXCLUDED[name].length).toBeGreaterThan(40);
    }
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
