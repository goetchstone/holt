#!/usr/bin/env bash
# .claude/hooks/pre-pr-check.sh
#
# PreToolUse hook: fires before `Bash(gh pr create*)` invocations.
#
# Per CLAUDE.md rule 48, every PR runs through the local Sonar/Semgrep/OSV
# gate before push -- including docs-only PRs. Per rule 19/36, substantial
# code changes update the matching domain runbook in the same PR.
#
# Hook surfaces the pre-pr checklist AND blocks if:
#   - app/coverage/lcov.info is older than the most recent commit on the
#     current branch (tests + coverage haven't been re-run since the last
#     code change), scoped to diffs that actually touch instrumented code
#   - substantial code changed under app/src/{app,pages,lib,components}
#     but no docs/runbook/CLAUDE.md/ROADMAP.md was touched
#   - the local Sonar gate is RED with no documented bypass
#
# Degrades gracefully: every external dependency (python3, docker/curl
# reaching the local Sonar container, git having an origin/main to diff
# against) is optional. Missing tooling produces a WARNING and lets the
# command through -- a fresh clone with no Sonar container running must
# never be hard-blocked from opening a PR.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SKILL_PATH="$REPO_ROOT/.claude/skills/pre-pr/SKILL.md"
COVERAGE_PATH="$REPO_ROOT/app/coverage/lcov.info"
SONAR_PROJECT_KEY="holt"

HAVE_PY=0
command -v python3 >/dev/null 2>&1 && HAVE_PY=1

INPUT="$(cat)"
COMMAND=""
if [ "$HAVE_PY" -eq 1 ]; then
  COMMAND="$(printf '%s' "$INPUT" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('tool_input', {}).get('command', ''))" 2>/dev/null || echo "")"
fi

# Match `gh pr create` invocations only.
if [ -z "$COMMAND" ] || ! printf '%s' "$COMMAND" | grep -qE '(^|; *| && *)gh pr create'; then
  exit 0
fi

# Always surface the checklist as informational stderr.
{
  echo ""
  echo "-- PRE-PR CHECKLIST (CLAUDE.md rule 48 -- pilot's checklist) --"
  echo ""
  if [ -f "$SKILL_PATH" ]; then
    head -50 "$SKILL_PATH"
    echo ""
    echo "(Full checklist: $SKILL_PATH)"
  fi
  echo ""
} >&2

HAVE_MAIN=0
git -C "$REPO_ROOT" rev-parse --verify origin/main >/dev/null 2>&1 && HAVE_MAIN=1

# ---------------------------------------------------------------------
# HARD BLOCK 1: coverage report missing or stale, scoped to whether this
# diff actually touches instrumented source. A branch that only touches
# docs/.claude/**/workflows/scripts/config can't move a coverage number,
# so an older lcov is still accurate for it.
# ---------------------------------------------------------------------
COVERAGE_RELEVANT=0
if [ "$HAVE_MAIN" -eq 1 ]; then
  COVERAGE_RELEVANT=$(git -C "$REPO_ROOT" diff --name-only origin/main...HEAD 2>/dev/null \
    | grep -cE '^(app/src/|app/__tests__/|app/prisma/|scripts/)' || true)
  COVERAGE_RELEVANT=${COVERAGE_RELEVANT:-0}
else
  # No origin/main to diff against (e.g. shallow clone, detached HEAD) --
  # can't tell what's relevant, so don't block on it. Warn instead.
  echo "pre-pr: no origin/main ref available -- coverage staleness check skipped." >&2
fi

if [ "$COVERAGE_RELEVANT" -gt 0 ]; then
  if [ ! -f "$COVERAGE_PATH" ]; then
    cat <<EOF >&2
======================================================================
  BLOCKED: $COVERAGE_PATH not found.

  This branch touches instrumented source. Per CLAUDE.md rule 48,
  generate coverage before opening the PR:

      cd app && npm run test:coverage

  Then re-run \`gh pr create\`.
======================================================================
EOF
    exit 2
  fi

  NOW=$(date +%s 2>/dev/null || echo 0)
  COVERAGE_MTIME=$(stat -f %m "$COVERAGE_PATH" 2>/dev/null || stat -c %Y "$COVERAGE_PATH" 2>/dev/null || echo "$NOW")
  HEAD_MTIME=$(cd "$REPO_ROOT" && git log -1 --format=%ct 2>/dev/null || echo "$NOW")
  COVERAGE_AGE_SEC=$(( NOW - COVERAGE_MTIME ))
  HEAD_COMMIT_AGE_SEC=$(( NOW - HEAD_MTIME ))

  if [ "$COVERAGE_AGE_SEC" -gt "$HEAD_COMMIT_AGE_SEC" ]; then
    cat <<EOF >&2
======================================================================
  BLOCKED: coverage report is STALE.

  HEAD commit is newer than app/coverage/lcov.info. Re-run:

      cd app && npm run test:coverage

  Then re-run \`gh pr create\`.
======================================================================
EOF
    exit 2
  fi
else
  echo "pre-pr: no instrumented source in this diff -- coverage staleness check skipped." >&2
fi

# ---------------------------------------------------------------------
# HARD BLOCK 2: doc-discipline (CLAUDE.md rule 19/36). Substantial code
# change with no doc/runbook touch -- bypass via `docs-not-needed:` in a
# commit body on this branch.
# ---------------------------------------------------------------------
BRANCH_COMMITS=""
if [ "$HAVE_MAIN" -eq 1 ]; then
  BRANCH_COMMITS=$(git -C "$REPO_ROOT" log origin/main..HEAD --format=%B 2>/dev/null || echo "")
else
  BRANCH_COMMITS=$(git -C "$REPO_ROOT" log -1 --format=%B 2>/dev/null || echo "")
fi

DOC_MAP="$REPO_ROOT/.claude/hooks/domain-map.txt"
if [ -f "$DOC_MAP" ] && [ "$HAVE_MAIN" -eq 1 ]; then
  CHANGED=$(git -C "$REPO_ROOT" diff --name-only origin/main...HEAD 2>/dev/null || echo "")
  CODE_TOUCHED=$(echo "$CHANGED" | grep -cE '^app/src/(app|pages|lib|components)/' || true)
  CODE_TOUCHED=${CODE_TOUCHED:-0}
  DOCS_TOUCHED=$(echo "$CHANGED" | grep -cE '^(docs/|CLAUDE\.md$|ROADMAP\.md$)' || true)
  DOCS_TOUCHED=${DOCS_TOUCHED:-0}

  CODE_LINES=0
  if [ "$CODE_TOUCHED" -gt 0 ]; then
    CODE_LINES=$(git -C "$REPO_ROOT" diff origin/main...HEAD --shortstat -- 'app/src/app' 'app/src/pages' 'app/src/lib' 'app/src/components' 2>/dev/null \
      | grep -oE '[0-9]+ insertion|[0-9]+ deletion' | grep -oE '[0-9]+' | awk '{ s += $1 } END { print s+0 }')
    CODE_LINES=${CODE_LINES:-0}
  fi

  DOC_BYPASS=0
  if printf '%s' "$BRANCH_COMMITS" | grep -q 'docs-not-needed:'; then
    DOC_BYPASS=1
  fi

  if [ "$CODE_TOUCHED" -gt 0 ] && [ "$DOCS_TOUCHED" -eq 0 ] && [ "$DOC_BYPASS" -eq 0 ] && [ "$CODE_LINES" -gt 20 ]; then
    EXPECTED_DOCS=""
    while IFS='|' read -r pattern runbook; do
      [ -z "$pattern" ] && continue
      case "$pattern" in '#'*) continue ;; esac
      regex="^${pattern//\*/.*}\$"
      if echo "$CHANGED" | grep -qE "$regex"; then
        case "$EXPECTED_DOCS" in
          *"$runbook"*) ;;
          *) EXPECTED_DOCS="${EXPECTED_DOCS}    - ${runbook}\n" ;;
        esac
      fi
    done < "$DOC_MAP"

    cat <<EOF >&2
======================================================================
  BLOCKED: code changed but no docs/runbook/ROADMAP touched.

  This branch added $CODE_LINES lines under app/src/{app,pages,lib,components}/
  but no file under docs/ (and not CLAUDE.md or ROADMAP.md) was modified.

  Per CLAUDE.md rule 19/36, doc-updates ship in the same PR as code.
EOF
    if [ -n "$EXPECTED_DOCS" ]; then
      echo "" >&2
      echo "  Touched paths suggest these runbooks should be updated:" >&2
      printf '%b' "$EXPECTED_DOCS" >&2
    fi
    cat <<EOF >&2

  To proceed, either:

  (a) Update the runbook(s) above (or CLAUDE.md / ROADMAP.md), then
      re-run \`gh pr create\`.

  (b) Add a commit whose message body contains
      \`docs-not-needed: <one-line rationale>\`.

  Use sparingly -- if you're typing this for the third time in a week,
  the threshold is calibrated wrong.
======================================================================
EOF
    exit 2
  fi
fi

# ---------------------------------------------------------------------
# HARD BLOCK 3: Sonar Quality Gate must be GREEN (or RED with explicit
# bypass marker). Degrades to a WARNING if the local Sonar server can't
# be reached -- we cannot make every PR contingent on a container that
# may not be running on this machine (or a fresh clone that never set
# one up).
# ---------------------------------------------------------------------
SONAR_TOKEN=""
SONAR_HOST_URL="http://localhost:9000"
if [ -f "$REPO_ROOT/app/.env.local" ]; then
  SONAR_TOKEN=$(grep '^SONAR_TOKEN=' "$REPO_ROOT/app/.env.local" 2>/dev/null | cut -d= -f2- | tr -d '\n\r' || echo "")
  CFG_HOST=$(grep '^SONAR_HOST_URL=' "$REPO_ROOT/app/.env.local" 2>/dev/null | cut -d= -f2- | sed 's:/$::' | tr -d '\n\r' || echo "")
  [ -n "$CFG_HOST" ] && SONAR_HOST_URL="$CFG_HOST"
fi

GATE_JSON=""
if [ -n "$SONAR_TOKEN" ] && command -v curl >/dev/null 2>&1; then
  GATE_JSON=$(curl -s --max-time 2 -u "${SONAR_TOKEN}:" \
    "${SONAR_HOST_URL}/api/qualitygates/project_status?projectKey=${SONAR_PROJECT_KEY}" 2>/dev/null || echo "")
fi

if [ -z "$GATE_JSON" ] || ! echo "$GATE_JSON" | grep -q '"projectStatus"'; then
  cat <<EOF >&2
  NOTE: Sonar gate could not be queried (host: $SONAR_HOST_URL, token
  configured: $([ -n "$SONAR_TOKEN" ] && echo yes || echo no)). This is
  expected on a fresh clone or a machine without the local Sonar
  container running -- proceeding without a gate-state check. Verify
  manually if you have a Sonar server available:

      curl -s -u "\${SONAR_TOKEN}:" "${SONAR_HOST_URL}/api/qualitygates/project_status?projectKey=${SONAR_PROJECT_KEY}"
EOF
  exit 0
fi

if [ "$HAVE_PY" -eq 0 ]; then
  echo "  NOTE: python3 unavailable -- cannot parse Sonar gate JSON. Proceeding." >&2
  exit 0
fi

GATE_STATUS=$(echo "$GATE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['projectStatus']['status'])" 2>/dev/null || echo "UNKNOWN")

if [ "$GATE_STATUS" = "OK" ]; then
  echo "Pre-PR checks passed: coverage fresh, Sonar gate GREEN." >&2
  exit 0
fi

# Gate is RED (or unknown). Look for explicit bypass marker.
BYPASS_FOUND=0
if printf '%s' "$BRANCH_COMMITS" | grep -q 'sonar-gate-justified:'; then
  BYPASS_FOUND=1
fi

if [ "$BYPASS_FOUND" -eq 1 ]; then
  cat <<EOF >&2
  NOTE: Sonar gate is RED but a commit on this branch carries the
        \`sonar-gate-justified:\` marker. Bypass logged -- verify the PR
        body documents the failing condition + rationale before merging.
EOF
  echo "$GATE_JSON" | python3 -m json.tool >&2 2>/dev/null
  exit 0
fi

cat <<EOF >&2
======================================================================
  BLOCKED: Sonar Quality Gate is RED (or unknown: $GATE_STATUS).

  CLAUDE.md rule 48 expects a GREEN gate before push, or an explicit
  documented bypass. Failing conditions:

EOF
echo "$GATE_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for c in d.get('projectStatus', {}).get('conditions', []):
    if c.get('status') == 'ERROR':
        op = '<' if c.get('comparator') == 'LT' else '>'
        print(f\"      - {c.get('metricKey')}: actual {c.get('actualValue')} {op} threshold {c.get('errorThreshold')}\")
" >&2 2>/dev/null

cat <<EOF >&2

  To proceed, either:

  (a) Fix the violations: cd app && npm run test:coverage \\
      && cd $REPO_ROOT && npm run sonar:scan
      ...then re-run this command.

  (b) Document the trade-off: add a commit whose message body contains
      \`sonar-gate-justified: <rationale>\`. The PR body must also
      document the failing condition.
======================================================================
EOF
exit 2
