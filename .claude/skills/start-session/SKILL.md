---
name: start-session
description: Run at the start of every working session. Loads project context, checks what changed since last session, identifies priorities, and sets up the todo list. Follows CLAUDE.md rule 36 ORIENT step.
---

# Session Start Checklist

Run through every step below before writing any code. This is the ORIENT
phase from CLAUDE.md rule 36.

## Step 1: Check What Changed

```bash
git log --oneline -10
git status
cd app && npm test 2>&1 | tail -5
```

If tests are failing, flag it immediately before doing anything else.

## Step 2: Load Domain Context

Before modifying code in any domain, read the relevant runbook in
`docs/domains/`. The map from source path to runbook lives in
`.claude/hooks/domain-map.txt`. Only read the runbooks relevant to the task
at hand — don't load all of them unless the task is cross-cutting.

## Step 3: Check Pending Priorities

There is no hand-maintained priorities file. Gather what's actually
outstanding from live sources: open PRs and their CI state
(`gh pr list --state open`), `ROADMAP.md` items still open, any spawned task
chips, and CVE suppressions nearing `ignoreUntil` in `osv-scanner.toml`
(rule 54 — re-verify, don't just extend). Present those to the user and ask
what they want to work on.

## Step 4: Set Up Todo List

Once the user confirms what they want to work on, create a TodoWrite with
the planned tasks.

## Rules

- Do NOT write code during the ORIENT phase.
- Do NOT assume data behavior (rule 19) — read the runbook first.
- Always verify `npm run validate` and `cd app && npm test` pass before the
  first commit of a session.
- If starting work that touches dependencies or the lockfile, sweep CVEs
  first (rule 55) — `cd app && npm run security:deps` — so the gate isn't
  red for reasons unrelated to today's change.

## Quick Reference

| Item | Value |
|------|-------|
| Stack | Next.js 16 (App Router), Prisma, PostgreSQL 17, tRPC |
| Validate command | `cd app && npm run validate` |
| Test command | `cd app && npm test` (unit) / `npm run test:coverage` (combined gate) |
| Local Sonar/Semgrep/OSV | `cd app && npm run check:local` |
| Test DB | `fbc_test_db` only (rule 59) — never `saybrook`, `holt_saybrook`, `akritos` |
| Structured logging | `logger.info/warn/error` — never `console.*` in `src/` |
| Cancelled line rule | Every aggregation: `lineItemStatus: { not: "CANCELLED" }` (rule 33) |
| Revenue status rule | `status: { in: SALES_REVENUE_STATUSES }` includes RETURNED (rule 47) |
| Nullable column rule | `OR: [{ col: null }, { col: { not: "X" } }]` (rule 51) |
| Never push to | `main` directly — branch + PR always |
