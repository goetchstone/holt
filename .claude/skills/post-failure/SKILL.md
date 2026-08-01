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
- **Business rule / cross-cutting invariant** → propose a CLAUDE.md rule
  update with an origin pointing at this entry.
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
