# Development Workflow

The point of this workflow: catch bad code before it reaches prod, and
make Claude show its work through a reviewable diff every time. Solo
dev, but every change still goes through a PR so nothing sneaks in.

## The rule

**Never push to `main`.** Always work on a branch, open a PR, review the
diff in the GitHub UI, confirm all checks are green, then merge.

**Once a remote and CI are configured, enforce this server-side via GitHub branch protection.** Direct pushes to `main` are rejected by the GitHub server,
all three required CI checks (Lint/Typecheck/Format/Test, Semgrep,
Dependency CVE scan) must be green before a merge is allowed,
force-pushes and branch deletion are blocked, and PR thread resolution
is required. Ruleset id `<ruleset-id>` on `<your-org>/<your-repo>`.
The pre-push hook is still installed for fast local feedback (validate +
tests before the push hits the wire) — the server gate is what enforces.

The script that defines and applies the ruleset is
`scripts/apply-github-ruleset.sh`. Edit + re-run that file if the
required-check names change or new rules need adding.

## The lifecycle

```
  ┌─ feature/fix-X ─ commit ─ push ─┐
  │                                  ├─ CI ─ Security ─ Sonar (local) ─┐
  │                                  │                                  │
  └───────────────── PR ─────────────┘─── review diff ─── green? ─── merge ─ main ─ deploy.sh
```

### 1. Branch

```bash
git checkout -b feature/short-description main
```

Name convention: `feature/`, `fix/`, `security/`, `docs/`, `refactor/`.

### 2. Work

- Read CLAUDE.md + relevant `docs/domains/*.md` first (rule 36).
- Make the smallest change that solves the problem.
- Update tests. Update docs in the same PR.
- Run `npm run validate && npm test` locally before committing.

### 3. Commit

Atomic, imperative subject, explain the **why** not the **what**.

### 4. Local Sonar scan — required before push

Every PR runs through local Sonar before push. This is a hard gate, not a "consider running it." Mocked tests, source-text tripwires, mechanical refactors — everything. Scope discipline (rule 45) plus the local Sonar Quality Gate is what keeps the new-code window honest.

```bash
cd app
npm run test:coverage   # generate lcov.info Sonar reads
cd .. && npm run sonar:scan   # ~4 min container scan
# Wait for completion, then check the gate:
curl -s -u "${SONAR_TOKEN}:" \
  "${SONAR_HOST_URL:-http://localhost:9000}/api/qualitygates/project_status?projectKey=holt" \
  | python3 -m json.tool
```

The gate must show `"status": "OK"` (or all conditions individually OK). If `new_coverage` is below threshold or `new_violations > 0`, fix or explicitly justify before pushing — don't paper over it. The project uses the **"Holt realistic"** custom gate with `new_coverage >= 40%` (the 80% default is structurally unreachable for mixed-content PRs once UI files are excluded from the coverage denominator via `sonar.coverage.exclusions`).

If the change is docs-only (no code touched) the scan is still required — scope discipline says "don't trust your judgment that nothing else changed," verify it.

Then push:

### 5. Push → CI runs

Pre-push hook runs validate + tests locally. Then on push:

- **CI** (`.github/workflows/ci.yml`) — lint, typecheck, format, tests
- **Security** (`.github/workflows/security.yml`) — Semgrep + osv-scanner

Both post findings to the **Security** tab on GitHub.

### 7. Open PR

```bash
gh pr create --fill
```

The PR body must include a **Test plan** (what you actually tested) and
list any doc or runbook updates. If the local Sonar scan flagged anything that you accepted (e.g. coverage at 79% but justified, hotspot triaged), document it in the PR body so the diff reviewer sees the same context.

### 8. Review the diff

Even solo, read the PR diff in GitHub. That's the single biggest lever
that keeps Claude honest — the diff UI shows the full change in one
place without the in-conversation chatter obscuring it.

Look for:

- Scope creep (changes unrelated to the stated goal)
- Missing tests for new branches
- Silent fallbacks or status hacks (CLAUDE.md rule 40)
- Secrets or `console.log` left in

### 9. Merge

All checks green + diff reviewed → squash-merge. Delete the branch.

### 10. Deploy

```bash
# On the Docker host:
git pull origin main
./scripts/deploy.sh
```

`deploy.sh` verifies the health endpoint after the restart.

## Local security scans

The pre-push hook runs them automatically when relevant files changed,
so you rarely need to invoke them manually:

- **osv-scanner** runs when `package.json` or `package-lock.json` changed.
- **Semgrep** runs when `src/pages/api/`, `src/lib/auth/`, `lib/prisma.ts`,
  `lib/rateLimit.ts`, `lib/githubApp.ts`, `lib/gmailClient.ts`, or
  `lib/stripe*` changed.

Front-end-only changes skip both — CI still runs them on the push side
so nothing is missed, just not in your terminal.

**Force a scan on demand** when you want to verify something before
pushing (or during code review):

```bash
cd app
npm run security:scan        # Semgrep + osv-scanner together (~2 min)
npm run security:semgrep     # static analysis only (~90s)
npm run security:deps        # dependency CVE scan only (~20s)
```

Both run via Docker — no local install needed.

## Reading security findings (no Cloud dashboard required)

The Security workflow (`security.yml`) runs Semgrep + osv-scanner on every PR and surfaces findings in three places — none of which require GitHub Advanced Security or Semgrep Cloud:

1. **Inline PR diff annotations.** Each Semgrep ERROR-severity finding becomes a yellow/red marker next to the offending line when reviewing the PR diff. Click the marker to see the rule name and message.
2. **Run summary at top of the workflow page.** Click into the failing CI run; the summary shows a markdown table of findings.
3. **Downloadable artifacts.** `semgrep-findings` and `osv-findings` artifacts on every run contain the full SARIF + human-readable text + JSON. Download from the Actions tab.

GitHub Advanced Security ($49/active committer/mo on private repos) would put findings in the Security tab. We deliberately don't use it — the three surfaces above cover the same ground for our scale.

**Semgrep Cloud is also optional.** If you previously linked the repo to semgrep.dev for the dashboard view, that's fine but it's a nice-to-have, not a requirement. If the Cloud project is broken (e.g. after a repo move), just delete it — nothing in this workflow depends on it.

## Weekly review (Mondays, 10 min)

1. **CI security artifacts** — if any Mondays sweep run failed, download the `semgrep-findings` / `osv-findings` artifacts and triage. Otherwise, weekly sweep runs are green and there's nothing to do.
2. **Local Sonar scan** — run against `main` to see code-smell and coverage drift over the week:

   ```bash
   docker compose -f docker-compose.sonar.yml up -d  # if not running
   cd app && npm run test:coverage && npm run sonar:scan
   open http://localhost:9000
   ```

3. **ROADMAP.md** — move anything shipped to Done, bump priorities.

## Active branch protection

Server-side enforcement on `main` is configured via GitHub ruleset id `<ruleset-id>`
on `<your-org>/<your-repo>`. The configuration:

- **Direct pushes to `main` are rejected** at the GitHub server.
- **Required status checks** (must all be green before merge):
  - `Lint, Typecheck, Format, Test` (from `.github/workflows/ci.yml`)
  - `Semgrep static analysis` (from `.github/workflows/security.yml`)
  - `Dependency CVE scan` (from `.github/workflows/security.yml`)
- **Strict required status checks**: PR branches must be up-to-date with `main` before merging.
- **PR thread resolution required**: any review comments must be resolved.
- **Force-push blocked**, **branch deletion blocked**.

To apply, update, or audit the ruleset:

```bash
bash scripts/apply-github-ruleset.sh
```

The script is idempotent — running twice updates the existing ruleset rather
than duplicating it. The full JSON definition lives in that file; edit it and
re-run if the required-check names change or new rules are needed.

Inspect the active state at `https://github.com/<your-org>/<your-repo>/settings/rules`.

The client-side pre-push hook is still installed and runs validate + tests
before the push hits the wire. With server enforcement in place, the hook is
**fast feedback** rather than the actual gate — keep it because losing 30
seconds locally is much better than waiting for the GitHub Action queue.

## Emergency bypass

Only for live prod incidents where the proper workflow would make
downtime longer:

```bash
git push --no-verify              # skip pre-push hook (rarely needed)
# For branch protection: temporarily disable in GitHub settings, push,
# then re-enable. Leave a comment in the commit explaining why.
```

Every bypass should be followed by a PR that **documents why** and
**adds a rule or test** so the same shortcut isn't needed twice.

## The three failure modes this catches

1. **Claude claims done without verifying** — CI runs the tests, diff
   review surfaces missing ones.
2. **Scope creep in a "small fix"** — PR diff is the whole change in
   one readable surface.
3. **Security regression** — Semgrep catches auth gaps, osv-scanner
   catches new CVEs in unchanged deps.
