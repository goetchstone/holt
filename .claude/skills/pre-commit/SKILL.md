---
name: pre-commit
description: Run before every commit. Catches common mistakes that have caused regressions. Use this EVERY time before git commit.
---

# Pre-Commit Checklist

Run through every item. If ANY check fails, fix it before committing.

## 1. Validate and Test

```bash
cd app && npm run validate && npm test
```

If either fails, stop. Fix it. Do not commit with `--no-verify`.

## 2. Read Before Write

Before modifying any file, you must have read it first in this session. Do
not edit based on memory or assumptions about file contents.

## 3. Structured Logging

Never use `console.error`/`console.log`/`console.warn` in `src/lib/` or API
routes. Use `logger.info/warn/error` from `@/lib/logger`; use `logError` in
catch blocks. `console.*` is acceptable only in config files, scripts
outside `src/`, and test files.

## 4. Shared Contracts (rule 7)

If you touched a constant, enum, or value list read by both client and
server code, verify it's defined ONCE in `src/lib/` and imported by both —
not duplicated inline on either side.

## 5. Cancelled-Line / Revenue-Status Filters (rules 33, 47)

If you touched a report, dashboard, or any aggregation over `OrderLineItem`
or `SalesOrder`:

- Sums/counts over line items filter `lineItemStatus: { not: "CANCELLED" }`.
- Revenue queries over orders use `status: { in: SALES_REVENUE_STATUSES }`
  (includes RETURNED — dropping it double-counts every rewritten sale).

## 6. Nullable-Column Filters (rule 51)

If you wrote a new Prisma `where` clause on a column that can be NULL, never
use a naked `not:`/`notIn:`. Use
`OR: [{ col: null }, { col: { not: "X" } }]`. Verify with an actual
`findMany` against the shape, not just the WHERE object — some "valid"
shapes are rejected by Prisma at runtime on nullable strings.

## 7. Zero-Quantity / Status-Mutation Traps (rules 31, 39, 40)

- A count/aggregation/import over a line-item-shaped source: did you decide
  explicitly whether `orderedQuantity = 0` rows are in or out?
- Are you tempted to set a `status` field to fix a report symptom? Don't —
  fix the import at the boundary instead (rule 40).

## 8. Dependency / Lockfile Changes (rules 52, 53, 54)

If `package.json` or the lockfile changed:

- Verify with `npm ci`, never `npm install` — an incremental install can
  hide a breakage only CI's clean install surfaces.
- Never blanket-override a package with incompatible major lines
  (`brace-expansion`-shaped traps: a 1.x/2.x split where the same override
  can't satisfy both call shapes). Use version- or path-scoped overrides.
- If you renewed a CVE suppression, the reason must be re-verified against
  the CURRENT tree, not copied forward from the last time it was true.

## 9. Read Before Write on Persisted Shapes

If you added a field to anything deserialized from OUTSIDE the program
(localStorage, a cookie, a cached JSON blob): what happens when the key is
absent on data written by an earlier version? An `as T` at the parse
boundary hides the gap from the compiler. Fill the gap on hydration
(`{ ...initial, ...parsed }`, per entry for nested maps).

## 10. Self-Heal Sweep (rule 49)

If you fixed a bug shape, `grep` for the same shape elsewhere. Mechanical →
fix all sites in this commit/PR with one shared-helper regression test.
Non-mechanical → ship the targeted fix, spawn tasks for the rest (rule 50).

## 11. Verify Claims Against Code, Not Docs (rule 56)

If this commit's message or a runbook update asserts "X is currently Y" —
confirm it against the source you opened this session, not against what a
doc said last time someone wrote it.

## 12. Docs Follow Code — Same Commit, Not "Later"

If this commit fixes a bug or ships a feature, before you say "done":

- Domain runbook touched if the change is substantial (rule 19, enforced by
  `pre-pr-check.sh` per `.claude/hooks/domain-map.txt`).
- If a runner/payment/auth file changed, confirm the trace evidence exists
  for the PR body (rule 45).
- Deferred work captured as a spawned task or `ROADMAP.md` entry, not just
  mentioned in chat (rule 50).

**Red flag**: if you're about to write "all done" without having checked
the items above, stop.
