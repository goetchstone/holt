---
name: post-failure
description: Run after any regression, broken test, or user-reported bug caused by a change in this session. Documents the failure and adds a rule to prevent it from happening again.
---

# Post-Failure Learning

Something broke. Before fixing it, document it. Every failure is a lesson
that makes the system better.

## Step 1: Identify the Root Cause

Answer these questions:

1. **What broke?** (exact symptom the user saw)
2. **What caused it?** (which change, which line, which assumption)
3. **Why wasn't it caught?** (test gap, missing validation, untested path)
4. **What would have prevented it?** (what check, test, or rule)

## Step 2: Reproduce Before Fixing

Produce a query, fixture, or failing test that reproduces the symptom
against real data before writing the fix. The reproduction is the proof the
fix targets the actual cause — and it becomes the regression test. Keep it,
name it clearly, commit it.

## Step 3: Fix the Bug

Fix the actual issue. Verify with `cd app && npm run validate && npm test`.

## Step 4: Add a Rule or Tripwire

- **Coding pattern to avoid** → add to `.claude/skills/pre-commit/SKILL.md`.
- **Missing test pattern** → add to the domain runbook's test-coverage
  section, or a tripwire test naming the bug class (prefer a real-DB
  integration test over a source-text tripwire where the behavior is
  testable — rule 57).
- **Business rule / cross-cutting invariant** → append an entry to
  `docs/RULE-FEEDBACK.md`, not a rule to CLAUDE.md. Say which principle this
  is an instance of, or `NEW` if none fits, and answer "would a rule have
  caught it?" — the answers "no" and "only if enforced differently" are the
  valuable ones. `.claude/skills/improve-rules/SKILL.md` reads the ledger
  later and proposes the constitutional change as a PR, with the distance that
  makes the judgment worth trusting.
- **Data assumption** → update the relevant `docs/domains/*.md` runbook.

## Step 5: Update the Failure Log

Add an entry below. Format: symptom, root cause, why not caught, fix,
prevention/tripwire. This is the institutional memory of what NOT to do —
future sessions should read recent entries before working in a domain that
has prior ones.

---

## Failure Log

<!--
Add entries below this line, newest first. One entry per distinct
incident. Keep the five-field shape: Symptom / Root cause / Why not
caught / Fix / Prevention. Link the CLAUDE.md rule it fed, if any.
-->

### 2026-10-15 — order balance charged for cancelled and replaced lines

- **Symptom:** an order with a cancelled or replaced line showed the customer
  owing for it — the overcharge reached the portal, payment links and balance
  reminders. Pre-launch; only seed data was affected.
- **Root cause:** `computeBalance` (`src/lib/paymentService.ts`) summed
  `netPrice` over every line. Cancelled and REPLACED lines keep their
  `netPrice` on the row, so "every row" is not "what is owed".
- **Why not caught:** the unit fixtures had only ACTIVE lines, so the sum and
  the correct sum agreed; no real-DB test built an order with a dead line.
- **Fix:** `COUNTED_LINE_STATUSES` / `isCountedLine` in `salesOrderRevenue.ts`,
  applied in `computeBalance`; `calculateOrderBalance` selects the status.
- **Prevention:** `orderBalanceCountedLines.integration.test.ts` (fails at
  3448 vs 1720 with the guard removed). Feeds rule 33 — about 60 other inline
  line filters still re-derive the set by hand; consolidating them onto the
  helper is tracked in `docs/domains/sales-orders.md`.
