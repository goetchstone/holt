-- Ledger Risk #138: structural double-entry guarantee.
-- A journal entry can never be committed with unequal debit and credit totals.
-- The application layer (assertBalanced in lib/journalEntry.ts) derives the
-- totals from the lines and returns a friendly error; this CHECK is the backstop
-- that no code path — including a raw write or a future bug — can bypass.
ALTER TABLE "JournalEntry"
  ADD CONSTRAINT "JournalEntry_balanced_check" CHECK ("totalDebits" = "totalCredits");
