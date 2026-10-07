#!/usr/bin/env bash
# scripts/apply-github-ruleset.sh
#
# The server-side gate for `main`, as code. Creates or updates the
# "main protection" ruleset and the repository's security settings so that
# what docs/CI-OPERATIONS.md and docs/WORKFLOW.md describe is what GitHub
# enforces. Idempotent: re-run it after editing the lists below.
#
# Usage (needs a token with admin on the repo):
#   scripts/apply-github-ruleset.sh [owner/repo]     # default: goetchstone/holt
#
# What `main` requires:
#   - a pull request (no direct pushes), every review thread resolved;
#   - every PR gate below green on a branch that is up to date with main;
#   - no force-push, no deletion;
#   - no open high-or-critical CodeQL alert (default setup analyses every PR,
#     Dependabot's included). Semgrep gates as a required check instead: its
#     SARIF upload needs a write token that Dependabot PRs do not get, so a
#     code-scanning rule on it would wedge them.
# No bypass actors: an admin who needs a gap removes the ruleset and says
# why in the PR that follows (docs/CI-OPERATIONS.md, "Emergency bypass").
#
# Required checks are only ones that report on EVERY pull request. A job
# skipped by its own `if:` reports "skipped", which passes; a workflow
# filtered out by a top-level `paths:` never reports, and would block every
# PR it skips. Keep it that way, or take the check out of this list.
set -euo pipefail

REPO="${1:-goetchstone/holt}"
RULESET_NAME="main protection"
GITHUB_ACTIONS_APP_ID=15368

REQUIRED_CHECKS=(
  "Lint, Typecheck, Format, Test"   # ci.yml: validate (unit + integration, coverage gate)
  "Setup, build, boot, smoke"       # ci.yml: fresh setup, seed coverage, build, smoke
  "Semgrep static analysis"         # security.yml
  "npm advisory audit"              # security.yml
  "Dependency CVE scan"             # security.yml: OSV (skips unless the lockfile changes)
  "Markdown lint"                   # markdownlint.yml
)

checks_json=$(printf '%s\n' "${REQUIRED_CHECKS[@]}" | sed 's/[[:space:]]*#.*$//' |
  jq -R --argjson app "$GITHUB_ACTIONS_APP_ID" '{context: ., integration_id: $app}' | jq -s .)

ruleset=$(jq -n --arg name "$RULESET_NAME" --argjson checks "$checks_json" '{
  name: $name,
  target: "branch",
  enforcement: "active",
  bypass_actors: [],
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [
    { type: "deletion" },
    { type: "non_fast_forward" },
    { type: "pull_request", parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: true } },
    { type: "required_status_checks", parameters: {
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
        required_status_checks: $checks } },
    { type: "code_scanning", parameters: { code_scanning_tools: [
        { tool: "CodeQL", security_alerts_threshold: "high_or_higher", alerts_threshold: "errors" } ] } }
  ]
}')

existing=$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$RULESET_NAME\") | .id")
if [[ -n "$existing" ]]; then
  echo "$ruleset" | gh api -X PUT "repos/$REPO/rulesets/$existing" --input - --jq '"updated ruleset " + (.id|tostring)'
else
  echo "$ruleset" | gh api -X POST "repos/$REPO/rulesets" --input - --jq '"created ruleset " + (.id|tostring)'
fi

# Security settings. Secret scanning push protection refuses a push that
# carries a recognised credential, before it reaches the history.
gh api -X PATCH "repos/$REPO" --input - --jq '"security: " + (.security_and_analysis | tostring)' <<'JSON'
{ "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" } } }
JSON
gh api -X PUT "repos/$REPO/vulnerability-alerts" && echo "dependabot alerts: enabled"
gh api -X PUT "repos/$REPO/automated-security-fixes" && echo "dependabot security updates: enabled"
gh api -X PUT "repos/$REPO/private-vulnerability-reporting" && echo "private vulnerability reporting: enabled"
gh api -X PATCH "repos/$REPO/code-scanning/default-setup" -f state=configured -f query_suite=extended \
  --jq '"codeql default setup: " + (.run_id|tostring)' || echo "codeql default setup: see repo Settings > Code security"
