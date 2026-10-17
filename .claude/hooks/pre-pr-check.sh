#!/usr/bin/env bash
# .claude/hooks/pre-pr-check.sh
#
# PreToolUse hook: fires before `Bash(gh pr create*)` invocations.
#
# Per CLAUDE.md rule 48, every PR runs through the local gate
# (npm run check:local: lint, tests, Semgrep, OSV) before push -- including
# docs-only PRs. CodeQL runs in CI. Per rule 19/36, substantial
# code changes update the matching domain runbook in the same PR.
#
# Hook surfaces the pre-pr checklist AND blocks if:
#   - app/coverage/lcov.info is older than the most recent commit on the
#     current branch (tests + coverage haven't been re-run since the last
#     code change), scoped to diffs that actually touch instrumented code
#   - substantial code changed under app/src/{app,pages,lib,components}
#     but no docs/runbook/CLAUDE.md/ROADMAP.md was touched
#
# (A third block, the local SonarQube quality gate, was removed 2026-10-16
# with SonarQube itself: CodeQL in CI covers the analysis.)
#
# Degrades gracefully: every external dependency (python3, git having an
# origin/main to diff against) is optional. Missing tooling produces a
# WARNING and lets the command through -- a fresh clone must never be
# hard-blocked from opening a PR.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SKILL_PATH="$REPO_ROOT/.claude/skills/pre-pr/SKILL.md"
COVERAGE_PATH="$REPO_ROOT/app/coverage/lcov.info"

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

echo "Pre-PR checks passed." >&2
exit 0
