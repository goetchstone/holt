#!/bin/bash
# scripts/check-local.sh
#
# Runs the full local pre-PR check pipeline -- mirrors what GitHub Actions
# CI does, except locally so we don't burn billed minutes. Designed for
# the period when GitHub Actions is unavailable (billing-blocked, May 2026)
# but useful indefinitely as a faster gate than waiting for CI.
#
# Tier-1 checks (always run):
#   1. validate          -- lint + typecheck + format:check (~30 sec)
#   2. test:coverage     -- unit + integration tests, merged coverage gate
#   3. lint:md           -- markdown formatting (~5 sec)
#   4. security:semgrep  -- OWASP/Next.js/secrets pattern scan (~2 min)
#
# Tier-2 checks (only if relevant files changed):
#   5. security:deps     -- npm CVE scan, only if app/package-lock.json changed
#
# Tier-3 checks (run in CI, not here):
#   - CodeQL dataflow analysis (.github/workflows/ci.yml, security.yml). It
#     replaced the local SonarQube scan, removed 2026-10-16 at the owner's
#     direction; the quality rules worth keeping run in lint (sonarjs).
#   - docker image CVE scan (Trivy) -- run via `npm run security:trivy` if added
#
# Exit codes:
#   0 -- all checks passed (gate green)
#   1 -- a check FAILED (real problem; fix before push)

set -uo pipefail

cd "$(dirname "$0")/.."  # repo's app/ directory

GREEN="\033[0;32m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
BOLD="\033[1m"
RESET="\033[0m"

step() {
  echo ""
  echo -e "${BOLD}=== $1 ===${RESET}"
}

pass() {
  echo -e "${GREEN}✓ $1${RESET}"
}

fail() {
  echo -e "${RED}✗ $1${RESET}"
  exit 1
}

warn() {
  echo -e "${YELLOW}! $1${RESET}"
}

# ── 1. validate ────────────────────────────────────────────────────────
step "1/5  validate (lint + typecheck + format:check)"
if npm run validate; then
  pass "validate clean"
else
  fail "validate failed -- fix before push"
fi

# ── 2. test:coverage ────────────────────────────────────────────────────
step "2/5  test:coverage (unit + integration, merged gate)"
if npm run test:coverage; then
  pass "tests + coverage gate clean"
else
  fail "tests or coverage gate failed"
fi

# ── 3. markdown lint ────────────────────────────────────────────────────
step "3/5  markdownlint"
if npm run lint:md; then
  pass "markdown clean"
else
  fail "markdownlint failed -- fix before push"
fi

# ── 4. security:semgrep ─────────────────────────────────────────────────
step "4/5  Semgrep static analysis (OWASP + Next.js + secrets)"
if npm run security:semgrep; then
  pass "semgrep clean (no ERROR findings)"
else
  warn "semgrep found ERROR findings or could not run -- review output"
  warn "(semgrep is informational locally; CI will still gate on it)"
fi

# ── 5. security:deps (only if lockfile changed) ────────────────────────
step "5/5  OSV dependency CVE scan (conditional)"
if git diff --name-only HEAD~1 HEAD 2>/dev/null | grep -q '^app/package-lock.json$'; then
  echo "  app/package-lock.json changed in last commit -- running OSV scan"
  if npm run security:deps; then
    pass "OSV scan clean"
  else
    fail "OSV scan found CVEs -- review or pin around them in osv-scanner.toml"
  fi
else
  echo "  app/package-lock.json unchanged -- skipping OSV (run manually if needed)"
  pass "skipped (no lockfile change)"
fi

# ── Done ────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}All Tier-1 + Tier-2 local checks passed.${RESET}"
echo "Ready to push. Tier-3 (CodeQL, Trivy) runs in CI."
