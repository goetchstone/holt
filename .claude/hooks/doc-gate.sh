#!/usr/bin/env bash
# .claude/hooks/doc-gate.sh
#
# The runbook half of the pre-PR gate (CLAUDE.md rules 19 and 36), on its own so
# `app/__tests__/docGate.test.ts` can run it against made-up branches. Called by
# pre-pr-check.sh; reads everything from the environment:
#
#   DOC_GATE_CHANGED     files changed on the branch, one per line
#   DOC_GATE_CODE_LINES  lines added + removed under app/src/{app,pages,lib,components,server}
#   DOC_GATE_COMMITS     the branch's commit messages
#   DOC_GATE_MAP         path to domain-map.txt
#
# Each changed source file takes the runbook of the FIRST map line it matches.
# A line whose runbook is `-` names files with no runbook of their own (shared
# infrastructure); they ask for nothing. A branch past 20 lines must touch every
# runbook its files map to. One that changed only unmapped or `-` files must touch
# some doc. `docs-not-needed: <reason>` in a commit message waives both.
#
# Exit 0 to pass, 2 to block (the message goes to stderr).

set -uo pipefail

CHANGED="${DOC_GATE_CHANGED:-}"
CODE_LINES="${DOC_GATE_CODE_LINES:-0}"
COMMITS="${DOC_GATE_COMMITS:-}"
MAP="${DOC_GATE_MAP:?DOC_GATE_MAP must be set}"

CODE_FILES=$(printf '%s\n' "$CHANGED" | grep -E '^app/src/(app|pages|lib|components|server)/' || true)
[ -z "$CODE_FILES" ] && exit 0
[ "$CODE_LINES" -le 20 ] && exit 0
printf '%s' "$COMMITS" | grep -q 'docs-not-needed:' && exit 0

# Patterns and runbooks, in file order.
PATTERNS=()
RUNBOOKS=()
while IFS='|' read -r pattern runbook _reason; do
  [ -z "$pattern" ] && continue
  case "$pattern" in '#'*) continue ;; esac
  PATTERNS+=("$pattern")
  RUNBOOKS+=("$runbook")
done <"$MAP"

EXPECTED=""
while IFS= read -r file; do
  [ -z "$file" ] && continue
  for i in "${!PATTERNS[@]}"; do
    # The map's `*` matches across directories, as the coverage test reads it.
    regex="^$(printf '%s' "${PATTERNS[$i]}" | sed -e 's/[][().+?^$|{}\\]/\\&/g' -e 's/\*/.*/g')\$"
    if printf '%s\n' "$file" | grep -qE "$regex"; then
      runbook="${RUNBOOKS[$i]}"
      if [ "$runbook" != "-" ]; then
        case $'\n'"$EXPECTED" in *$'\n'"$runbook"$'\n'*) ;; *) EXPECTED="${EXPECTED}${runbook}"$'\n' ;; esac
      fi
      break
    fi
  done
done <<<"$CODE_FILES"

if [ -n "$EXPECTED" ]; then
  MISSING=""
  while IFS= read -r runbook; do
    [ -z "$runbook" ] && continue
    printf '%s\n' "$CHANGED" | grep -qxF "$runbook" || MISSING="${MISSING}    - ${runbook}"$'\n'
  done <<<"$EXPECTED"
  [ -z "$MISSING" ] && exit 0
  cat <<EOF >&2
======================================================================
  BLOCKED: this branch changed $CODE_LINES lines of code, and these runbooks
  cover the files it changed but were not updated:

${MISSING}
  Per CLAUDE.md rules 19 and 36, the runbook changes in the same PR as the
  code it describes. Update each one, or add a commit whose message contains
  \`docs-not-needed: <one-line reason>\`.
======================================================================
EOF
  exit 2
fi

if printf '%s\n' "$CHANGED" | grep -qE '^(docs/|CLAUDE\.md$)'; then
  exit 0
fi
cat <<EOF >&2
======================================================================
  BLOCKED: this branch changed $CODE_LINES lines of code under app/src and no
  file under docs/ (nor CLAUDE.md). Its files map to no runbook in
  .claude/hooks/domain-map.txt, so name the one that should cover them, update
  a doc, or add a commit whose message contains
  \`docs-not-needed: <one-line reason>\`.
======================================================================
EOF
exit 2
