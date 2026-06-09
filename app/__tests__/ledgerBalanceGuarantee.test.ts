// /app/__tests__/ledgerBalanceGuarantee.test.ts
//
// Ledger Risk #138: a journal entry can never be committed out of balance.
// Two layers guard this; these source tripwires fail loudly if either is removed:
//   1. DB CHECK constraint (totalDebits = totalCredits) in the migration.
//   2. The generate path asserts balance before the write (friendly error).
// assertBalanced's own behavior is unit-tested in journalEntry.test.ts.

import fs from "node:fs";
import path from "node:path";

const APP_ROOT = path.join(__dirname, "..");

describe("Ledger balance guarantee (#138)", () => {
  it("ships a DB CHECK constraint enforcing totalDebits = totalCredits", () => {
    const dir = path.join(APP_ROOT, "prisma", "migrations", "20260606_journal_entry_balance_check");
    const sql = fs.readFileSync(path.join(dir, "migration.sql"), "utf8");
    expect(sql).toMatch(/ALTER TABLE\s+"JournalEntry"/);
    expect(sql).toMatch(/CHECK\s*\(\s*"totalDebits"\s*=\s*"totalCredits"\s*\)/);
  });

  it("asserts balance in the generate path before persisting", () => {
    const src = fs.readFileSync(path.join(APP_ROOT, "src", "lib", "journalEntry.ts"), "utf8");
    expect(src).toMatch(/assertBalanced\(result\.lines\)/);
  });
});
