# CI Operations

How quality gates run, what runs where, and what to do when something's blocked.

## TL;DR

Every PR runs through this gate:

| Check | Where it runs | When | Required to merge? |
|---|---|---|---|
| Lint / Typecheck / Format / Test (unit + integration, coverage gate) | GitHub Actions (`ci.yml`) | Every PR + every push to `main` | **Yes** |
| Setup, build, boot, smoke | GitHub Actions (`ci.yml`) | Every PR + every push to `main` | **Yes** |
| Semgrep static analysis | GitHub Actions (`security.yml`) | Every PR | **Yes** |
| npm advisory audit | GitHub Actions (`security.yml`) | Every PR | **Yes** |
| Dependency CVE scan (OSV) | GitHub Actions (`security.yml`) | Every PR + weekly (it scans the whole lockfile every time; nothing skips it on a PR) | **Yes** |
| Markdown lint | GitHub Actions (`markdownlint.yml`) | Every PR | **Yes** |
| CodeQL (default setup, extended suite) | GitHub-managed | Every PR + weekly | **Yes**: the ruleset refuses a merge with a high-or-critical alert |
| Client-data tripwire | Inside the unit tests | Every PR; patterns from the `CLIENT_DATA_PATTERNS` secret | **Yes** (fails without the secret) |
| Secret scanning push protection | GitHub | Every push | **Yes**: a push carrying a recognised credential is refused |
| Docker image CVE scan (Trivy) | GitHub Actions (`security.yml`) | **Weekly Monday + manual `workflow_dispatch`** | No |
| OpenSSF Scorecard | GitHub Actions (`scorecard.yml`) | Every push to `main` + weekly (Tuesday) | No: publishes the README badge and the report at [scorecard.dev](https://scorecard.dev/viewer/?uri=github.com/goetchstone/holt) |

## Why this shape

### Background — the CI minute-burn audit

The original CI fired 7 jobs on every PR push regardless of what changed. Audit found:

- **CodeQL static analysis** (`security.yml`) was a pure duplicate of GitHub-managed default-setup CodeQL. ~5 min/PR for zero added value.
- **Trivy Docker scan** ran on every PR (not just Dockerfile changes). ~5 min/PR including the image build.
- **Markdown lint** ran on code-only PRs. ~1 min/PR for nothing.
- **OSV scan** ran when the lockfile hadn't changed. ~2 min/PR for nothing.
- **CI test suite** ran on docs-only PRs. ~5 min/PR for nothing.

Result: ~20 min/PR average, $20 of GitHub Actions overage in 6 days at high PR cadence.

### Where it landed

The trim removed the manual CodeQL job, moved Trivy to weekly-only and dropped
the push-to-main triggers (next section). It also path-filtered CI, OSV and
markdownlint; **those path filters are gone**. A required check that a filter
skips never reports and blocks the merge, so every required check now runs on
every PR to `main` (see "Required-status-checks" below). The per-PR minute
figures the trim recorded (~7 min for a code PR, 0 min for a docs-only one)
described the path-filtered shape and no longer hold; they have not been
re-measured. For scale, PRs #13 and #14 ran `Lint, Typecheck, Format, Test` for
about 21 and 23 minutes. GitHub Actions is free on this public repository, which
is why always-run was judged the right trade.

Only Trivy stays off the PR path: it runs **weekly on `main`** and on manual
`workflow_dispatch`.

### Drop push-to-main triggers

Each merged PR fires the same 3 workflows TWICE if `push: branches: [main]` triggers are left on:

1. Once on `pull_request` (the gate that determined merge-eligibility)
2. Once on `push: branches: [main]` (the squash commit, which is identical code)

The push-to-main re-run is paranoia tax — the same code just passed the PR gate. Remove `push: branches: [main]` from `ci.yml`, `security.yml`, and `markdownlint.yml`. Retain `workflow_dispatch` on all three so an admin can re-run from the GitHub UI when needed.

Per-PR-cycle math: ~40% reduction in run count. CodeQL still fires twice (PR + push) because it's GitHub default-setup, controlled in the UI, not workflow files.

**Exception, 2026-10-15: `security.yml` runs on push to `main` again.** Its
README badge reads the latest run on `main`, and without a push trigger that was
only ever the weekly sweep. The 2026-10-12 sweep failed on two advisories, the
fixes merged on 2026-10-15, and the badge still said "failing" until a run was
dispatched by hand. The repository is public, so the extra run costs nothing.

**Exception, 2026-10-17: `ci.yml` runs on push to `main` again**, for the same
reason. Its README badge (`badge.svg?branch=main`) had no run on `main` at all,
since every CI run was on a PR branch, so it read "no status". `markdownlint.yml`
still has no push trigger; it has no badge.

### CodeQL — the remaining big-ticket item

GitHub default-setup CodeQL runs on every push AND every PR (~5-10 min for a TS codebase this size). It's the largest single minute-burner per push and can't be tuned via workflow files.

To trim further: GitHub → repo Settings → Code security → Code scanning → switch CodeQL from **Default** to **Advanced** setup. That generates an editable workflow file you can schedule to weekly instead of per-push. Per-PR runs go from 5 → 3.

Tracked as an optional cost-saving step; do this if the $5/month budget runs tight.

## The local check pipeline

`npm run check:local` (in `app/`) runs the local-developer equivalent of CI. (It ran a local SonarQube scan as well until 2026-10-16; CodeQL in CI covers that ground, and the SonarSource rules worth keeping run in lint through `eslint-plugin-sonarjs`.)

1. **`validate`** — lint + typecheck + format (~30 sec)
2. **`test:coverage`** — unit + integration tests, merged coverage gate (~1 min)
3. **`lint:md`** — markdown formatting (~5 sec). Lints only Markdown git tracks or would track (`"gitignore": true` in `.markdownlint-cli2.jsonc`), so gitignored local docs such as `/PLAN.md` can't fail it. CI's Markdown lint job runs this same script, so both use the markdownlint-cli2 version pinned exactly in `app/package.json` (Dependabot bumps it)
4. **`security:semgrep`** — OWASP/Next.js/secrets pattern scan (~2 min via Docker)
5. **`security:deps`** — OSV CVE scan, only when `package-lock.json` changed in last commit (~30 sec)

Most of the wall time is the integration tests.

The `pre-pr-check.sh` hook fires before `gh pr create` and verifies:

- `coverage/lcov.info` exists and is newer than the HEAD commit (i.e. tests were re-run since last code change)
- substantial code under `app/src` changed with a runbook (or CLAUDE.md / ROADMAP.md) touched, OR a commit on the branch carries a `docs-not-needed: <rationale>` marker

## Required setup (local checks)

One-time:

```bash
# Pull the Docker images used by the local Semgrep + OSV scans
docker pull semgrep/semgrep
docker pull ghcr.io/google/osv-scanner:latest
```

Markdownlint and Jest are devDependencies in `app/package.json`, so `npm ci` in `app/` installs them — no separate install.

## When CI is unavailable (billing-blocked, network down, etc.)

If GitHub Actions is unavailable, you can still ship by:

1. Run `npm run check:local` locally (covers everything CI checks except CodeQL deep dataflow)
2. Disable branch protection temporarily (admin only):

   ```bash
   gh api /repos/goetchstone/holt/rulesets/24667944 -X PUT \
     --input - <<< '{"enforcement":"disabled"}'
   ```

3. Ship the PR (squash-merge from GitHub UI)
4. Re-enable branch protection:

   ```bash
   gh api /repos/goetchstone/holt/rulesets/24667944 -X PUT \
     --input - <<< '{"enforcement":"active"}'
   ```

## Trigger heavy scans on demand

Trivy and any other scheduled-only check can be fired manually from the Actions tab. `workflow_dispatch` runs every job in `security.yml`, so this also re-runs Semgrep, the npm audit and OSV:

```bash
gh workflow run security.yml --ref main
```

Or via the UI: `https://github.com/goetchstone/holt/actions/workflows/security.yml` → "Run workflow"

## Required-status-checks (server-side ruleset)

The `main protection` ruleset (id `24667944`) is defined in
`scripts/apply-github-ruleset.sh`; edit that file and re-run it, never the
settings page, so the repository records what GitHub enforces. It requires:

- a pull request, with every review thread resolved (no approving review is
  required: there is one maintainer);
- these checks green, on a branch up to date with `main`:
  `Lint, Typecheck, Format, Test`, `Setup, build, boot, smoke`,
  `Semgrep static analysis`, `npm advisory audit`, `Dependency CVE scan`,
  `Markdown lint`;
- no high-or-critical CodeQL alert on the PR;
- no force-push and no deletion of `main`. There are no bypass actors.

A required check must report on every pull request. A job skipped by its own
`if:` reports "skipped", which passes; a workflow filtered by a top-level
`paths:` never reports and would block every PR it skips. None of the six
required jobs is skipped on a pull request today: the OSV job's `if:` lists
`pull_request` among the events that run it, and the only job that does skip
on PRs is Trivy, which is not required. Semgrep gates as a check rather than
through a code-scanning rule, because its SARIF upload needs a write token that
Dependabot PRs do not get.

The same script turns on secret scanning with push protection, Dependabot
alerts and security updates, private vulnerability reporting and CodeQL
default setup.

## What gates each job

None of the three workflows has a `paths:` or `paths-ignore:` key
(`grep -nE '^\s*(paths|paths-ignore):' .github/workflows/*.yml` returns
nothing), so no change is too small to skip a workflow. What decides whether a
job runs is its trigger and its own `if:`, if it has one.

### `ci.yml`

Triggers: `pull_request` to `main`, and `workflow_dispatch`. Neither job has an
`if:`, so both run on every pull request, whatever the diff touches (a
docs-only PR runs the full suite).

- `validate` ("Lint, Typecheck, Format, Test"): install, Prisma generate,
  `npm run validate`, `npm run typecheck:strict`, then the merged unit +
  integration coverage gate against a Postgres service container.
- `smoke` ("Setup, build, boot, smoke"): `npm run setup`, the migrations-match-
  schema diff, seed coverage, `npm run build`, boot, `scripts/smoke.sh`.

### `security.yml`

Triggers: `pull_request` to `main`, `push` to `main`, a weekly `schedule`
(Monday 06:00 UTC) and `workflow_dispatch`.

| Job | Gate |
|---|---|
| `semgrep` ("Semgrep static analysis") | None: every trigger. Scans `app/src` and `scripts` |
| `semgrep-upload` | `always() && needs.semgrep.result != 'skipped'`: runs even when Semgrep failed, since that is when there is a SARIF to publish |
| `npm-audit` ("npm advisory audit") | None: every trigger. Production dependencies, high or above |
| `osv-scanner` ("Dependency CVE scan") | None: every trigger. Scans the whole lockfile every time, with the suppressions in `app/osv-scanner.toml` |
| `trivy` ("Docker image CVE scan (weekly)") | `schedule` or `workflow_dispatch` only: never on a PR |

### `scorecard.yml`

Triggers: `push` to `main`, a weekly `schedule` (Tuesday 07:20 UTC) and
`workflow_dispatch`. One job runs `ossf/scorecard-action` and publishes the
result (the badge and the scorecard.dev report read it). Publishing restricts
the file: no top-level `env`/`defaults`, no workflow-level write permission, and
the analysis job may only use `actions/checkout`, `actions/upload-artifact`,
`github/codeql-action/upload-sarif` and the scorecard action, with no `run:`
steps. Results are not uploaded to code scanning, because the checks a solo
maintainer cannot pass (Code-Review, the approval tier of Branch-Protection,
Maintained until the repo is 90 days old) would sit in the Security tab as
alerts nothing can close.

### `markdownlint.yml`

Triggers: `pull_request` to `main`, a weekly `schedule` (Monday 06:30 UTC) and
`workflow_dispatch`. One job, no `if:`: every pull request lints every tracked
Markdown file, not only the ones it changed. That also matters for what it
lints with: markdownlint-cli2's version lives in `app/package.json` and
`app/package-lock.json`, so a PR that only bumps it must run this check.

## Adding a new check

If you add a new linter / scanner / type-check:

1. **Decide the cost shape**: cheap (< 30 sec) → run on every PR. Expensive (> 2 min) → schedule-only on `main` + `workflow_dispatch`, gated by a job-level `if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'` as `trivy` is.
2. **Do not add a top-level `paths:` / `paths-ignore:` filter to a workflow that holds a required check.** A filtered workflow never reports on the PRs it skips, and a required check that never reports blocks the merge. To skip work, gate the job with `if:` instead: a skipped job reports "skipped", which passes.
3. **Add to `npm run check:local`** so developers can run it before push.
4. **To make it required, add its job `name:` to `REQUIRED_CHECKS` in `scripts/apply-github-ruleset.sh` and re-run the script.** Only do so once the check runs on every pull request.
5. **Pin every action to a full commit SHA, with the release as a comment** (`uses: actions/checkout@<40-hex sha> # v7.0.1`). A tag can be moved to different code after you review it; a SHA cannot. Dependabot's `github-actions` ecosystem bumps the SHA and the comment together. Docker base images in `app/Dockerfile` are pinned by digest the same way (`node:24-alpine@sha256:…`), and Dependabot's `docker` ecosystem keeps the digest current. Scorecard's Pinned-Dependencies check fails on any unpinned one.

## Audit trail

Track significant CI changes here as they're made. Initial entries to record when setting up a new deployment:

| Date | Change |
|---|---|
| 2026-10-07 | Fresh repository. `main protection` ruleset `24667944` created by `scripts/apply-github-ruleset.sh`: six required checks, strict, CodeQL high-alert rule, push protection, Dependabot security updates, private vulnerability reporting, CodeQL default setup |
| 2026-10-15 | OpenSSF Scorecard added (`scorecard.yml`, README badge). Every action pinned to a commit SHA and the Dockerfile base image to a digest. `osv-scanner.toml` moved beside the lockfile (`app/`), where Scorecard reads it. `security.yml` runs on push to `main` again so its badge tracks `main` |
| 2026-10-17 | `ci.yml` runs on push to `main` again, so its README badge reads `main` instead of "no status" |
| — | Local Sonar gate required before push. **Removed 2026-10-16:** SonarQube, its compose file, gate script and hook block are gone; CodeQL (default setup, required) covers the analysis |
| — | CI trim: dropped manual CodeQL job, moved Trivy to weekly-only, path-filtered OSV/markdownlint, dropped `Dependency CVE scan` from required-status-checks. Reduced per-PR minutes from ~20 to ~7. **Superseded:** none of the workflows carries a path filter now, and `Dependency CVE scan` is a required check again (2026-10-07 row above), so the ~7 minutes describes a shape that no longer exists. |
