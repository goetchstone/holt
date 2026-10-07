#!/usr/bin/env bash
# .claude/hooks/rules-improver-check.sh
#
# Nudges toward `.claude/skills/improve-rules/SKILL.md` once enough evidence has
# accumulated to be worth a pass.
#
# Event-driven, not time-driven, on purpose. A weekly cron runs whether or not
# anything happened, and a pass with nothing to read either returns "no change"
# (wasted) or invents one (worse). A fix commit is the signal that the rules met
# reality and something gave, so counting those fires the improver exactly when
# there is something to learn from.
#
# NEVER blocks. This is a prompt for a human decision, not a gate — the whole
# point of the improver is that it runs with distance, so forcing it mid-session
# would defeat it.

set -euo pipefail
cd "$(dirname "$0")/../.."

THRESHOLD="${RULES_IMPROVER_THRESHOLD:-8}"
STAMP=".claude/.rules-last-run"
SINCE=$(cat "$STAMP" 2>/dev/null || echo "")

if [ -n "$SINCE" ]; then
  RANGE=(--since="$SINCE")
else
  # No stamp yet: look back a sensible window rather than all of history.
  RANGE=(--since="6 weeks ago")
fi

FIXES=$(git log "${RANGE[@]}" --format='%s' 2>/dev/null \
  | grep -icE '^(fix|revert)' || true)
FIXES=${FIXES:-0}

LEDGER=0
if [ -f docs/RULE-FEEDBACK.md ]; then
  if [ -n "$SINCE" ]; then
    # Ledger entries are "### YYYY-MM-DD — ..."; count those dated after the stamp.
    LEDGER=$(grep -oE '^### [0-9]{4}-[0-9]{2}-[0-9]{2}' docs/RULE-FEEDBACK.md \
      | awk -v s="$SINCE" '{ if (substr($2,1,10) > s) n++ } END { print n+0 }')
  else
    LEDGER=$(grep -cE '^### [0-9]{4}-[0-9]{2}-[0-9]{2}' docs/RULE-FEEDBACK.md || true)
  fi
fi
LEDGER=${LEDGER:-0}

SIGNAL=$(( FIXES + LEDGER ))

if [ "$SIGNAL" -ge "$THRESHOLD" ]; then
  cat <<MSG

─────────────────────────────────────────────────────────────────
  Rules improver: $SIGNAL signals since ${SINCE:-6 weeks ago}
    $FIXES fix/revert commits + $LEDGER ledger entries  (threshold $THRESHOLD)

  Worth an observer pass:  /improve-rules
  It reads the accumulated evidence and proposes ONE focused edit to
  CLAUDE.md as a PR. "No change warranted" is a successful outcome.
─────────────────────────────────────────────────────────────────

MSG
fi

exit 0
