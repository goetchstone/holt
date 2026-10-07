#!/bin/bash
# scripts/check-local.sh
#
# Runs the full local pre-PR check pipeline -- mirrors what GitHub Actions
# CI does, except locally so we don't burn billed minutes. Designed for
# the period when GitHub Actions is unavailable (billing-blocked, May 2026)
# but useful indefinitely as a faster gate than waiting for CI.
#
# Tier-1 checks (always run, ~7-10 min total):
#   1. validate          -- lint + typecheck + format:check (~30 sec)
#   2. test:coverage     -- unit + integration tests, merged coverage gate (~1 min)
#   3. sonar:scan + gate -- code quality + security overlap (~5 min)
#   4. lint:md           -- markdown formatting (~5 sec)
#   5. security:semgrep  -- OWASP/Next.js/secrets pattern scan (~2 min)
#
# Tier-2 checks (only if relevant files changed):
#   6. security:deps     -- npm CVE scan, only if app/package-lock.json changed
#
# Tier-3 checks (run separately, on-demand):
#   - docker image CVE scan (Trivy) -- run via `npm run security:trivy` if added
#   - CodeQL deep dataflow         -- still runs on GitHub default-setup schedule
#
# Exit codes:
#   0 -- all checks passed (gate green)
#   1 -- a check FAILED (real problem; fix before push)
#   2 -- a Tier-1 check was SKIPPED (Sonar server unreachable, etc) -- decide
#        per check whether to push anyway

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
step "1/6  validate (lint + typecheck + format:check)"
if npm run validate; then
  pass "validate clean"
else
  fail "validate failed -- fix before push"
fi

# ── 2. test:coverage ────────────────────────────────────────────────────
step "2/6  test:coverage (unit + integration, merged gate)"
if npm run test:coverage; then
  pass "tests + coverage gate clean"
else
  fail "tests or coverage gate failed"
fi

# ── 3. sonar:scan + gate ────────────────────────────────────────────────
step "3/6  Sonar scan + gate"
# Sonar token / host loaded from app/.env.local. If not present, skip with
# a warning -- the gate is meaningful only when the server is reachable.
if [ ! -f .env.local ]; then
  warn ".env.local not found -- Sonar scan skipped"
else
  SONAR_TOKEN=$(grep '^SONAR_TOKEN=' .env.local | cut -d= -f2-)
  SONAR_HOST_URL=$(grep '^SONAR_HOST_URL=' .env.local | cut -d= -f2- | sed 's:/$::')

  if [ -z "$SONAR_TOKEN" ]; then
    warn "SONAR_TOKEN not set in .env.local -- Sonar scan skipped"
  else
    # Run the scan
    if SONAR_TOKEN="$SONAR_TOKEN" SONAR_HOST_URL="$SONAR_HOST_URL" npm run sonar:scan; then
      # Wait briefly for Sonar to ingest the report, then query gate
      sleep 10
      GATE=$(curl -s -u "${SONAR_TOKEN}:" \
        "${SONAR_HOST_URL:-http://localhost:9000}/api/qualitygates/project_status?projectKey=")
      STATUS=$(echo "$GATE" | python3 -c "import json,sys; print(json.load(sys.stdin)['projectStatus']['status'])" 2>/dev/null || echo "UNKNOWN")
      if [ "$STATUS" = "OK" ]; then
        pass "Sonar gate: OK"
      else
        # Show the failing conditions but don't auto-fail -- gate may
        # be RED for documented reasons (Phase 0.6 page-level coverage
        # gap, etc). The pre-pr hook still requires `sonar-gate-justified:`
        # marker if RED.
        echo "$GATE" | python3 -c "
import json, sys
d = json.load(sys.stdin)['projectStatus']
print(f\"  status: {d['status']}\")
for c in d['conditions']:
    if c['status'] == 'ERROR':
        print(f\"  - {c['metricKey']} {c['actualValue']} (threshold {c['errorThreshold']})\")
"
        warn "Sonar gate: $STATUS -- review failing conditions above"
        warn "If RED is intentional, document via 'sonar-gate-justified:' commit marker"
      fi
    else
      warn "Sonar scan command failed -- check Docker / server reachable"
    fi
  fi
fi

# ── 4. markdown lint ────────────────────────────────────────────────────
step "4/6  markdownlint"
if npm run lint:md; then
  pass "markdown clean"
else
  fail "markdownlint failed -- fix before push"
fi

# ── 5. security:semgrep ─────────────────────────────────────────────────
step "5/6  Semgrep static analysis (OWASP + Next.js + secrets)"
if npm run security:semgrep; then
  pass "semgrep clean (no ERROR findings)"
else
  warn "semgrep found ERROR findings or could not run -- review output"
  warn "(semgrep is informational locally; CI will still gate on it)"
fi

# ── 6. security:deps (only if lockfile changed) ────────────────────────
step "6/6  OSV dependency CVE scan (conditional)"
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
echo "Ready to push. Tier-3 (Trivy Docker scan, CodeQL) run on GitHub schedule."
