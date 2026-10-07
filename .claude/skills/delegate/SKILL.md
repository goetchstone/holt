---
name: delegate
description: How to farm work to subagents effectively in this repo. Use before any investigation reading >5 files with a short answer, or any bounded implementation contained to one domain — read this before spawning an Agent/Task.
---

# Delegating Work to Subagents

The main thread is for synthesis, decisions, and writing code that needs
the full conversation's context. Everything else delegates. Running
everything in the main thread is how sessions run context-hot (multiple
compactions per session) — that's the sign delegation should have happened
earlier.

## When to delegate

1. **Investigation** — research reading >5 files that produces a short
   answer ("where does X get computed", "find every site that imports Y",
   "audit the codebase for bug shape Z"). Use `Explore`.
2. **Bounded implementation** — a feature contained to one domain,
   describable in 3 bullets, that doesn't need to coordinate with other
   in-flight work. Use `general-purpose`, isolated in a git worktree.
3. **Plan generation for unfamiliar work** — multi-step work whose shape
   you don't know yet. Use `Plan`.

Before "let me grep across the codebase" or "let me read these 8 files" —
ask if this is a delegatable investigation first.

## Isolate in a git worktree

Give implementation agents their own worktree so their commits don't
tangle with the main thread's in-progress diff:

```bash
git worktree add ../holt-<short-task-name> -b <branch-name>
```

**`node_modules` gotcha**: a symlinked `node_modules` into a worktree is
fine for `jest` (module resolution doesn't care), but **breaks Turbopack
dev** (`npm run dev`) — Next.js's dev server resolves through the real
filesystem path and a symlink confuses its file-watcher / module graph in
ways that are hard to diagnose from the symptom alone. If the agent's task
touches `npm run dev` or needs to visually verify a page, it needs a REAL
`npm ci` in the worktree, not a symlink shortcut. If the task is
test-only (`jest`, `npm run validate`), the symlink shortcut is fine and
much faster.

## Match the model to the task

- **Cheap model, low effort** — mechanical ports, grep-and-report,
  inventory tasks, straightforward adaptation of an existing pattern to a
  new file (e.g. "port this skill file's structure to a sibling domain").
- **Stronger model** — feature assembly, anything requiring judgment about
  which of several plausible approaches is correct, anything touching
  money/auth/reporting invariants (rules 33, 40, 41, 42, 47, 51).
- Spend the strongest tier on the **verifier**, not the **producer**, when
  the task allows it — a cheap producer checked by a careful skeptic beats
  the reverse for catching subtle logic errors.

## Brief the agent like a colleague who just walked in

- Give the exact files to read first — don't make the agent rediscover the
  domain map.
- State the goal, the constraint set, and what you've already ruled out.
- State the expected output shape (a code patch, a step list, a <500-word
  answer).
- Name the relevant CLAUDE.md rules and runbook if the task touches a
  domain with known invariants (money/reporting rules especially — a
  fresh-context agent has no memory of why `RETURNED` orders stay in a
  revenue sum).

## Split large read-phase tasks

A single investigation that requires reading a very large number of files
tends to stall or truncate rather than degrade gracefully — split it into
narrower sub-investigations (by domain, by file pattern) and run them
separately, or in parallel, rather than handing one agent an unbounded
"read everything relevant" brief.

## Always re-verify a subagent's risky claims yourself

An agent's summary describes what it intended to do, not necessarily what
it did. Before reporting delegated work as done:

- Read the actual diff, not just the agent's description of it.
- Re-run the tests it claims pass.
- For claims about production behavior, external systems, or anything the
  agent couldn't directly exercise, check whether it flagged the claim as
  unverified (rule 58) — if it didn't and the claim is unverifiable from
  this environment, that's a gap to close before trusting the report.

## Mark chapters at pivots

Use `mcp__ccd_session__mark_chapter` at meaningful transitions — incident
detected → investigation → fix → verification → next plan. Keeps the
transcript navigable and signals prior context is closed, which matters
more once delegation means the main thread is stitching together several
agents' work rather than doing everything itself.
