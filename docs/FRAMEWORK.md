# A Prompt-Engineering Framework for Single-Developer + AI Workflows

This document describes a framework for working with Claude Code (or any agentic-coding LLM) on a real-world production codebase. It was built incrementally, one incident at a time, on a single-developer + Claude Code project with ~370 API endpoints, ~900 tests, daily ingestion from a legacy POS, and multiple retail locations depending on the output for daily operations.

The framework is opinionated. It is not what Anthropic ships out of the box. It is built on top of their primitives (CLAUDE.md, skills, hooks, subagents, MCP, plan mode, TodoWrite) and adds the discipline layer that single-developer workflows specifically need — because there is no second pair of eyes, no PR review, no senior engineer reading your diffs. The model has to be the second pair of eyes, and the structure has to make that role enforceable.

If you take only one slide from this document: **rules earn their place by surviving incidents. Tests prove the bug would have failed pre-fix. Migrations restore from columns the bug couldn't touch. Skills + hooks make the right path the easy path.**

---

## 1. The problem we were solving

Solo developer + AI authoring code at high velocity. No PR review. Multiple retail locations depending on the output. Daily ingestion from a legacy POS that exports CSVs with no consistent conventions. Several incident classes that recurred:

- **Same bug shape, different file** — fix landed in one spot, the duplicate-shape fix didn't.
- **Mocked-only tests passing while production broke** — the mock agreed with whatever you stubbed.
- **Migrations matching zero rows in prod** — guards written from memory didn't match shifted positions.
- **Half-done fixes** — the user thought the bug was closed; two days later the same symptom returned through a different code path.

The framework below is the structural answer to those four classes.

---

## 2. Three-layer architecture

Everything written for the model to read fits into one of three layers. The split matters because without it CLAUDE.md becomes 5,000 lines that no model can hold in working memory — and the model will silently start ignoring rules at the bottom.

| Layer | File | Purpose | Read frequency | Audience |
|---|---|---|---|---|
| **Constitution** | `CLAUDE.md` | Numbered rules with origins. Survive every session. | Every session start | Always loaded |
| **Domain runbooks** | `docs/domains/*.md` | Specialized knowledge per area (sales, accounting, imports, returns, customers, etc.) | When working in that domain | Loaded by topic |
| **Skills** | `.claude/skills/*/SKILL.md` | Activatable workflows for specific moments (pre-commit, post-failure, deploy, start-session, mid-session) | When the moment arrives | Activated explicitly |

CLAUDE.md is the constitution — short, numbered, every rule has an origin link to the failure that birthed it. Runbooks are the law library — domain-specific, cross-referenced, only relevant when working in the domain. Skills are procedures — checklists you activate at specific moments (pre-commit, before-PR, after-failure).

When CLAUDE.md grows past ~200 lines of rules, you move detail into runbooks and leave the rule short.

---

## 3. Three enforcement mechanisms

Every rule needs a home that matches its enforcement strength:

| Mechanism | What it does | Strength | When to use |
|---|---|---|---|
| **Skills** | Soft prompt — the model reads when activated | Persuasive, not enforced | "Be sure to check X" |
| **Hooks** | Run code on tool events; can hard-block a tool call | Hard gate | "Don't push if Sonar is RED" |
| **Tripwire tests** | Source-text scan that fails CI if a guard is missing | Backstop | "This code path must always have this filter" |

The mental model: **"Where does this rule live so it can't be forgotten?"**

- A rule in a skill is a polite reminder. Useful for soft conventions ("comments explain *why*, not *what*").
- A rule in a hook is a runway closure. Useful for hard gates ("local Sonar must pass before push").
- A rule in a tripwire test is a CI failure. Useful for invariants the codebase must keep ("every aggregation over OrderLineItem.netPrice must filter `lineItemStatus != 'CANCELLED'`").

The pattern: when an incident teaches you a rule, ask which of the three is the right home. Don't put a hard gate in a skill — Claude will read it once and forget.

---

## 4. The learning loop

This is the most important diagram. Every incident flows through it, and the codebase ratchets up a notch each cycle.

```
Production failure
       ↓
Post-failure log entry
   ├─ symptom: what the user actually saw
   ├─ cause: which line, which assumption
   ├─ why-not-caught: test gap, missing validation, untested code path
   ├─ fix: what shipped
   └─ meta-lesson: the generalizable principle
       ↓
Recurring shape? ──── YES ───→ CLAUDE.md rule with origin link
       ↓
       NO
       ↓
Tripwire test that asserts the bug couldn't have happened again
       ↓
Next session: model sees the rule, the tripwire fires on regression,
the skill activates around the relevant moment.
```

Concrete artifact: `.claude/skills/post-failure/SKILL.md`. Every incident in the project has an entry. The CLAUDE.md rules each link back to their origin entry. New rules don't get added unless there's an incident behind them — that keeps CLAUDE.md from bloating with speculative best-practices.

**Rules earn their place by surviving incidents.** Don't add a rule because it sounds good; add it when an incident proves it's needed. The rule then has gravitas because it has a story behind it.

---

## 5. The four discipline anti-patterns

These are the failure modes you'll catch yourself in. Naming them helps you stop.

### A. Verbal "we'll get to it later"

The PR mentions "follow-up needed for X" in passing. The conversation scrolls. Three weeks later, X is forgotten.

**Fix**: deferred work has exactly two valid endpoints — a spawned task chip (a fresh-context capsule that survives the session) or an entry in `ROADMAP.md` / a plan file. The PR body must reference where the deferred item is tracked. Mentioning it only in chat is not acceptable.

### B. Silent ignores on findings

Sonar / CodeQL / Semgrep flags a finding. You think "that's not really an issue here." You ignore it. Next scan, it's still there. Six weeks later, 70 ignored findings have accumulated.

**Fix**: every finding has exactly three valid endpoints — **fixed**, **tripwire-tested** (a test guards against regression of the underlying pattern), or **explicitly marked won't-fix in the upstream tool with rationale** (so it doesn't churn back next scan). Silent-ignore is forbidden.

### C. Half-done fixes

The user reports a bug. You fix the path the report mentioned. Two days later they hit the same symptom through a different code path. The bug is the same shape; you just didn't grep for it.

**Fix**: when fixing a bug shape, grep the codebase for the same shape. Fix all sites in the same PR (mechanical sweep) or spawn task chips for sites that need different handling. The PR body documents the full sweep. The user trusts the fix because it covers the shape, not the report.

### D. Mocked-only tests

The unit tests pass. They mock Prisma; the mock returns whatever you set up. The production query has a different filter, a different status check, a different field name. Production breaks, the tests stay green.

**Fix**: every test declares its grade (A pure helper / B real-DB integration / B- source-text tripwire / C+ mocked-Prisma placeholder). C+ tests must carry a placeholder header tracking their upgrade path. Real-DB integration tests are the default for any code path that touches the DB. The Phase 0.6 migration in this codebase converted six C+ runners to A-grade integration tests; every conversion caught at least one latent bug the mock had been hiding.

---

## 6. Worked example — three migrations, one lesson

This is the teaching example. Three migrations on the same data corruption, each iteration lifting a lesson to a rule.

### The bug

A daily sales report diverges from the source-of-truth POS system by ~$7,800 on a single order. The import runner had been cancelling lines it misidentified as orphans — an edge case where the POS "rewrites" an order by splitting it into base + rewrite records, and the daily CSV export only carries the surviving lines.

### Migration 1: wrong guard

Used `lineNumber` guards hand-typed from the prior session's notes. By prod-apply time the line numbers had shifted due to a re-import that re-ordered the lines. All UPDATE clauses matched zero rows. Migration ran to completion with `ROW_COUNT=0` across the board.

**Lesson**: migration guards must be position-independent. Use stable identifiers (`partNo + qty`) instead of row positions.

### Migration 2: wrong values

Improved guards (`partNo + qty + bad-netPrice`) but the **target values** were also typed from memory. Of three multi-qty corrections, only one was right. Net effect: some lines under-counted, others missed entirely.

**Lesson**: target values must come from a column the corruption couldn't touch. Not from a memo.

### Migration 3: the right shape

Used `netPrice = ROUND(vatAmount / vatRate, 2)`. The vat columns survived all the corruption (the runner only damaged `netPrice`, `partNo`, `productName` — never `vatAmount` or `vatRate`). The relationship is exact at the source. Closed the entire gap on first apply.

**Lesson lifted to CLAUDE.md rule 13**: *"Restoration migrations derive target values from a column the corruption didn't touch — never from a memo."*

### Why this matters

Each migration corresponds to a class of mistake the framework now prevents:

- Migration 1 → rule 13 (stable identifiers in migration guards)
- Migration 2 → rule 13 (same rule — the same lesson learned twice)
- Code-side fix → multiple rules: fix-by-pattern (don't fix one site of a bug shape and forget the duplicate), integration tests must cover the bug shape

The user trusted Migration 1 closed the bug. Two days later they hit the same symptom. That's the trust hit the framework prevents — by codifying the lesson into a rule with a tripwire, the same shape can't recur silently.

---

## 7. What aligns with Anthropic's defaults — and what we go beyond

### What aligns (this is the standard Claude Code workflow)

- **CLAUDE.md** as project context
- **Skills** as activatable instruction packets
- **Hooks** for deterministic enforcement (`PreToolUse`, `SessionStart`, etc.)
- **Subagents** for bounded tasks (`Explore`, `Plan`, `general-purpose`)
- **Plan mode** for complex multi-step work
- **TodoWrite** for in-session task tracking
- **MCP servers** for integrations
- **Spawned task chips** (CCD/Cowork-flavored) for deferred work

### What we go beyond (project-specific extensions)

- **Hard-block hooks with bypass markers**. Anthropic's hook docs show advisory checks. We've made them enforcement gates with a documented escape hatch (`sonar-gate-justified:` in the commit body). The hook runs `python3 -c` against the Sonar API and exits 2 if the gate is RED, blocking `gh pr create`.
- **Test grading rubric** (A / B / B- / C+) with `__tests__/testGrading.test.ts` enforcing placeholder headers. Every mocked-Prisma test must carry a `// PLACEHOLDER TEST — Grade: C+` header pointing at the upgrade target.
- **Failure log as structured tripwire**. Every entry has symptom + cause + why-not-caught + fix + meta-lesson. The pre-commit hook hard-blocks `fix(...)` commits if the failure log wasn't touched in the last hour.
- **Domain runbooks split out of CLAUDE.md**. CLAUDE.md is the constitution; runbooks are the law library. Without the split, CLAUDE.md grows past what the model can hold.
- **Ratchet doctrine on coverage thresholds**. Bump the floors after measuring, never speculate. Lock in gains.
- **Real-DB integration test harness** with `withTestDb`. Anthropic doesn't prescribe a test architecture; we built this to escape the mocked-Prisma trap that caused multiple April incidents.

---

## 8. What we'd do differently if starting today

These are the gaps the framework exposed in itself, in our own self-assessment:

- **Lean harder on subagents.** We use `Explore` for research occasionally but tend to do everything in the main thread. Anthropic's pattern is "send a specialized agent for the bounded task, keep your context clean." We run hot — context compactions happen mid-session, and that's a sign we should have delegated. Specifically: any investigation that requires reading >5 files but produces a <500-word answer should be delegated. Any feature contained to one domain that fits in 3 bullets should be delegated to a `general-purpose` agent in a worktree.
- **Use `mark_chapter` aggressively**. Natural session breakpoints (incident → investigation → fix → verification → next plan) should be marked chapters. Gives navigable transcripts and signals to the model that prior context is closed.
- **Build hooks for habits we wish we had.** A `PreToolUse` hook that counts `Read`/`Grep` calls in the last N tool uses and suggests delegation when the count hits a threshold. A `PostCompact` hook that re-loads the relevant runbook so post-compaction context isn't degraded.
- **Skills marketplace integration.** We have local skills; we rarely pull from `anthropic-skills:*`. Some of those are excellent (xlsx, pdf, docx); we under-use them.

---

## 9. The doctrine — one slide

> **Rules earn their place by surviving incidents.**
> **Tests prove the bug would have failed pre-fix.**
> **Migrations restore from columns the bug couldn't touch.**
> **Skills + hooks make the right path the easy path.**

That's the talk's takeaway. Every other slide unpacks one of those four sentences.

---

## 10. Adopting this framework

If you're starting fresh, do this in order:

1. **Write CLAUDE.md with five rules you actually mean.** Don't copy mine — they're calibrated to my incidents. Yours come from your incidents. If you have no incidents yet, start with: KISS, no-tech-debt, no-regressions, production-ready-only, LTS-only. Five is enough to start.
2. **Add a post-failure skill.** Every incident gets an entry. Every entry has the five fields (symptom / cause / why-not-caught / fix / meta-lesson). After 3-5 entries, patterns will emerge.
3. **Promote recurring patterns to CLAUDE.md rules** with origin links to their failure log entries. Don't add rules speculatively.
4. **Add hooks for the rules you can't trust the model to remember.** Sonar gate, pre-commit checklist, session-start orientation — these are good candidates.
5. **Add tripwire tests for invariants the codebase must hold.** Source-text scans are cheap; one passes per CI run.
6. **Split CLAUDE.md when it crosses ~200 lines.** Domain runbooks first, then skills.
7. **Use subagents from day one.** Don't develop the bad habit I have of doing everything in the main thread. Investigation → `Explore`. Bounded implementation → `general-purpose`. Plan generation → `Plan`.

The framework is incremental. It doesn't need to be all built before it's useful — it grows with your incident history. The discipline is what ships the value, not the artifacts.

---

## Appendix: file tree

```
project-root/
├── CLAUDE.md                          # Constitution (numbered rules)
├── ROADMAP.md                         # Long-running plans
├── docs/
│   ├── FRAMEWORK.md                   # This file
│   └── domains/
│       ├── accounting.md              # Domain runbooks (one per area)
│       ├── imports-overview.md
│       ├── reporting.md
│       ├── sales-orders.md
│       └── ...
├── .claude/
│   ├── settings.json                  # Hooks config (PreToolUse, SessionStart, etc.)
│   ├── hooks/
│   │   ├── pre-commit-check.sh        # Hard gate before git commit
│   │   ├── pre-pr-check.sh            # Hard gate before gh pr create
│   │   └── session-start-check.sh     # Informational session start
│   └── skills/
│       ├── pre-commit/SKILL.md        # 12-item checklist
│       ├── pre-pr/SKILL.md            # Pilot's pre-flight checklist
│       ├── post-failure/SKILL.md      # Failure log + structured entry format
│       ├── start-session/SKILL.md
│       ├── mid-session/SKILL.md
│       ├── end-of-session/SKILL.md
│       └── deploy/SKILL.md
└── app/
    └── __tests__/
        ├── testGrading.test.ts        # Tripwire: every mocked test has header
        ├── testHarness.test.ts        # Tripwire: TABLES_FOR_TEST_RESET in sync
        └── ...
```

The structure is a result, not a starting point. Build it as your incidents teach you.
