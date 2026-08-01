---
name: pre-pr
description: Run before every `gh pr create`. The pilot's pre-flight checklist for opening a pull request. Mandatory because every item below has been a real failure mode in this or the sibling repo. Skipping items causes silent regressions, swiss-cheese gaps, or wasted review cycles.
---

# Pre-PR Checklist

Once the PR is open, CI runs and the cost of finding a problem goes up. If
ANY item below isn't satisfied, fix it FIRST. Do not push then promise to
fix.

## 1. Pre-commit checklist already passed

Ran `.claude/skills/pre-commit/SKILL.md` before the most recent commit on
this branch. Re-run it if files changed since.

## 2. Dependency CVE sweep is current (rule 55)

If `package.json` / the lockfile / `osv-scanner.toml` changed on this
branch, or if it's been more than a few days since the last check, run:

```bash
cd app && npm run security:deps
```

New advisories publish continuously — sweep BEFORE opening the PR, not
after CI turns red for a reason unrelated to this diff.

## 3. Local Sonar / Semgrep / OSV gate evaluated AND documented (rule 48)

```bash
cd app && npm run check:local
```

The result belongs in the PR body, not just "I ran it." Every finding is
one of: fixed in this PR, tripwire-tested, or explicitly won't-fix with
rationale (never silent-ignore).

## 4. Trace-before-refactor evidence if touching shared infra (rule 45)

Any change to `lib/adapters/`, `lib/paymentService.ts`, `lib/auth/`,
`lib/secureUpload.ts`, `pages/api/automations/*`, or any import
runner/adapter must include a `grep -rn` snippet proving the touched
surface is disjoint from runtime call paths, or a list of dependents
confirmed tested. PR description says "Trace: …" with the evidence.

## 5. Domain runbook updated or `docs-not-needed:` marker (rule 19, 36)

Substantial changes under `src/{pages,app,lib,components}/` update the
matching `docs/domains/*.md` runbook (see `.claude/hooks/domain-map.txt`)
in the same PR. `pre-pr-check.sh` blocks `gh pr create` otherwise unless a
commit carries `docs-not-needed: <rationale>`.

## 6. Self-heal sweep done if applicable (rule 49)

If fixing a copy-paste-style bug shape, document the sweep in the PR body:
"Found bug shape in N files; fixed M mechanically in this PR; spawned tasks
for the remaining N-M" (rule 50).

## 7. Deferred work captured in spawned tasks or ROADMAP.md (rule 50)

Every KNOWN-but-deliberately-skipped item gets a spawned task chip or an
explicit `ROADMAP.md` entry. PR-body-only mentions scroll off and
disappear — that's not tracking.

## 8. Report unverifiable work as unverified (rule 58)

If any part of this PR could not actually be exercised in this environment
(no real domain for a TLS check, no access to a third-party sandbox), the
PR body says so explicitly. Don't imply something was tested that wasn't.

## 9. Verify claims against code, not docs (rule 56)

If the PR body or a runbook update makes a factual claim about current
behavior, it traces to source opened this session — not to what a doc said
last time.

## 10. Tests are meaningful, not coverage theatre (rule 12, 14)

A meaningful test asserts the buggy input would have failed pre-fix and
passes post-fix. Prefer real-DB integration tests for anything behind
Prisma; a source-text tripwire is acceptable only for "guard must exist
everywhere" bug classes and needs a comment naming that class (rule 57).

## 11. Branch name follows convention

`feature/`, `fix/`, `security/`, `docs/`, `refactor/`, `chore/`, `test/`.
No `wip-`, `temp-`, `branch1`.

## 12. PR body has the required sections

```
## Summary
(1-3 sentences on WHY, not WHAT — the diff shows what)

## Trace / Verification
(grep evidence per rule 45, or "unverifiable: <reason>" per rule 58)

## Scan / gate state
(table from item 3)

## Test plan
(- [ ] checkboxes for what the reviewer should verify)
```

## 13. Verify the gate is actually green BEFORE clicking merge

All required status checks COMPLETED + SUCCESS, gate state in the PR body
matches what was actually scanned, no unaddressed reviewer comments.

---

**The pilot doesn't fly without checking. The PR doesn't open without this
checklist.**
