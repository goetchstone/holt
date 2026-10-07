# CI Operations

How quality gates run, what runs where, and what to do when something's blocked.

## TL;DR

Every PR runs through this gate:

| Check | Where it runs | When | Required to merge? |
|---|---|---|---|
| Lint / Typecheck / Format / Test | GitHub Actions (`ci.yml`) | Every code PR | **Yes** |
| Semgrep static analysis | GitHub Actions (`security.yml`) | Every code PR | **Yes** |
| Sonar Quality Gate | Local (developer machine) | Pre-PR via `npm run check:local` | Hook-enforced via `pre-pr-check.sh` |
| Markdown lint | GitHub Actions (`markdownlint.yml`) | Only when `*.md` changes | No |
| Dependency CVE scan (OSV) | GitHub Actions (`security.yml`) | Only when `app/package-lock.json` changes + weekly | No |
| Docker image CVE scan (Trivy) | GitHub Actions (`security.yml`) | **Weekly Monday + manual `workflow_dispatch`** | No |
| Default-setup CodeQL | GitHub-managed schedule | Free tier scheduled, separate Actions pool | No |

## Why this shape

### Background — the CI minute-burn audit

The original CI fired 7 jobs on every PR push regardless of what changed. Audit found:

- **CodeQL static analysis** (`security.yml`) was a pure duplicate of GitHub-managed default-setup CodeQL. ~5 min/PR for zero added value.
- **Trivy Docker scan** ran on every PR (not just Dockerfile changes). ~5 min/PR including the image build.
- **Markdown lint** ran on code-only PRs. ~1 min/PR for nothing.
- **OSV scan** ran when the lockfile hadn't changed. ~2 min/PR for nothing.
- **CI test suite** ran on docs-only PRs. ~5 min/PR for nothing.

Result: ~20 min/PR average, $20 of GitHub Actions overage in 6 days at high PR cadence.

### After the trim (this doc)

Typical code PR: **~7 min** (CI + Semgrep). Down from ~20 min — 65% reduction.

Docs-only PR: **0 min** (everything path-ignored).

Lockfile change: ~9 min (CI + Semgrep + OSV).

Heavy scans (Trivy, full OSV sweep) still run **weekly on `main`** — same coverage, ~95% less burn.

### Drop push-to-main triggers

Each merged PR fires the same 3 workflows TWICE if `push: branches: [main]` triggers are left on:

1. Once on `pull_request` (the gate that determined merge-eligibility)
2. Once on `push: branches: [main]` (the squash commit, which is identical code)

The push-to-main re-run is paranoia tax — the same code just passed the PR gate. Remove `push: branches: [main]` from `ci.yml`, `security.yml`, and `markdownlint.yml`. Retain `workflow_dispatch` on all three so an admin can re-run from the GitHub UI when needed.

Per-PR-cycle math: ~40% reduction in run count. CodeQL still fires twice (PR + push) because it's GitHub default-setup, controlled in the UI, not workflow files.

### CodeQL — the remaining big-ticket item

GitHub default-setup CodeQL runs on every push AND every PR (~5-10 min for a TS codebase this size). It's the largest single minute-burner per push and can't be tuned via workflow files.

To trim further: GitHub → repo Settings → Code security → Code scanning → switch CodeQL from **Default** to **Advanced** setup. That generates an editable workflow file you can schedule to weekly instead of per-push. Per-PR runs go from 5 → 3.

Tracked as an optional cost-saving step; do this if the $5/month budget runs tight.

## The local check pipeline

`npm run check:local` (in `app/`) runs the local-developer equivalent of CI plus Sonar:

1. **`validate`** — lint + typecheck + format (~30 sec)
2. **`test:coverage`** — unit + integration tests, merged coverage gate (~1 min)
3. **`sonar:scan` + gate query** — code quality + duplications + cog complexity + some security (~5 min via Docker)
4. **`lint:md`** — markdown formatting (~5 sec)
5. **`security:semgrep`** — OWASP/Next.js/secrets pattern scan (~2 min via Docker)
6. **`security:deps`** — OSV CVE scan, only when `package-lock.json` changed in last commit (~30 sec)

Total wall time: ~7-10 min for a clean run.

The `pre-pr-check.sh` hook fires before `gh pr create` and verifies:

- `coverage/lcov.info` exists and is newer than the HEAD commit (i.e. tests were re-run since last code change)
- Sonar gate is GREEN, OR a commit on the branch carries `sonar-gate-justified: <rationale>` marker

## Required setup (local checks)

One-time:

```bash
# Pull the Docker images used by local Sonar + Semgrep + OSV scans
docker pull sonarsource/sonar-scanner-cli:latest
docker pull semgrep/semgrep
docker pull ghcr.io/google/osv-scanner:latest

# Sonar token + host go in app/.env.local (already gitignored):
echo 'SONAR_TOKEN=squ_xxxxxxxxxxxxxxxxxxxxxxxxx' >> app/.env.local
echo 'SONAR_HOST_URL=http://localhost:9000' >> app/.env.local

# Sonar server runs in Docker -- bring it up if not already:
docker compose up -d sonarqube  # or whatever your compose service is named
```

Markdownlint and Jest run via `npx` / `npm` — no separate install.

## When CI is unavailable (billing-blocked, network down, etc.)

If GitHub Actions is unavailable, you can still ship by:

1. Run `npm run check:local` locally (covers everything CI checks except CodeQL deep dataflow)
2. Disable branch protection temporarily (admin only):

   ```bash
   gh api /repos/<your-org>/<your-repo>/rulesets/<ruleset-id> -X PUT \
     --input - <<< '{"enforcement":"disabled"}'
   ```

3. Ship the PR (squash-merge from GitHub UI)
4. Re-enable branch protection:

   ```bash
   gh api /repos/<your-org>/<your-repo>/rulesets/<ruleset-id> -X PUT \
     --input - <<< '{"enforcement":"active"}'
   ```

## Trigger heavy scans on demand

Trivy, the full OSV sweep on unchanged lockfiles, and any scheduled-only check can be fired manually from the Actions tab:

```bash
gh workflow run security.yml --ref main
```

Or via the UI: `https://github.com/<your-org>/<your-repo>/actions/workflows/security.yml` → "Run workflow"

## Required-status-checks (server-side ruleset)

The `main protection` ruleset (id `<ruleset-id>`) requires two contexts to pass before merge:

- **`Lint, Typecheck, Format, Test`** — fires on every code PR (path filter excludes docs)
- **`Semgrep static analysis`** — fires on every code PR

Removed from required (they're now path-conditional and would otherwise block code-only PRs):

- `Dependency CVE scan` — runs only when lockfile changes; covered by weekly schedule + local `check:local`
- `CodeQL static analysis` — entirely removed (default-setup runs free on its own schedule)
- `Docker image CVE scan` — moved to weekly-only

To update the ruleset, edit `scripts/apply-github-ruleset.sh` and re-run.

## Path filters in detail

Each workflow's trigger has explicit paths or paths-ignore:

### `ci.yml`

```yaml
paths-ignore: ['**.md', 'docs/**', 'CLAUDE.md', 'ROADMAP.md', '.github/ISSUE_TEMPLATE/**', '.gitignore', '.markdownlintignore', '.markdownlint.json', 'env.example']
```

### `security.yml`

```yaml
paths: ['app/src/**', 'scripts/**', 'app/package-lock.json', 'app/Dockerfile', 'osv-scanner.toml', '.github/workflows/security.yml']
```

OSV runs only when lockfile / `osv-scanner.toml` changes (effectively a sub-filter on top of the above).
Trivy runs only on `schedule` + `workflow_dispatch` (not on PR push at all).

### `markdownlint.yml`

```yaml
paths: ['**.md', '.markdownlint.json', '.markdownlintignore', '.github/workflows/markdownlint.yml']
```

## Adding a new check

If you add a new linter / scanner / type-check:

1. **Decide the cost shape**: cheap (< 30 sec) → run on every code PR. Expensive (> 2 min) → schedule-only on `main` + `workflow_dispatch`.
2. **Add path filters** to scope what triggers it.
3. **Add to `npm run check:local`** so developers can run it before push.
4. **Don't add to required-status-checks unless it always runs**. If the workflow is path-conditional, requiring it will block PRs that don't trigger it.

## Audit trail

Track significant CI changes here as they're made. Initial entries to record when setting up a new deployment:

| Date | Change |
|---|---|
| — | Branch protection ruleset created (id `<ruleset-id>`) |
| — | Local Sonar gate required before push |
| — | CI trim: dropped manual CodeQL job, moved Trivy to weekly-only, path-filtered OSV/markdownlint, dropped `Dependency CVE scan` from required-status-checks. Reduced per-PR minutes from ~20 to ~7. |
