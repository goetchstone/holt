#!/usr/bin/env bash
# .claude/hooks/rules-improver-check.sh
#
# Nudges toward `.claude/skills/improve-rules/SKILL.md` once enough evidence has
# accumulated to be worth a pass.
#
# Event-driven, not time-driven, on purpose. A weekly cron runs whether or not
# anything happened, and a pass with nothing to read either returns "no change"
# (wasted) or invents one (worse). A merged fix is the signal that the rules met
# reality and something gave, so counting those fires the improver exactly when
# there is something to learn from.
#
# Fixes are counted by the merged PR's head branch (fix/, security/, sec/,
# revert/), not by commit subject. Squash merges are titled in prose, so from
# 2026-09-23 the subject never started with "fix" and the old count read 0 of 8
# for a month while eight fix PRs merged (RULE-FEEDBACK 2026-10-27).
#
# Prints its count every session, below the threshold too. Silence was how the
# old count hid: 0 looked the same as "nothing to learn".
#
# NEVER blocks. This is a prompt for a human decision, not a gate — the whole
# point of the improver is that it runs with distance, so forcing it mid-session
# would defeat it.

set -uo pipefail
cd "$(dirname "$0")/../.."

THRESHOLD="${RULES_IMPROVER_THRESHOLD:-8}"
STAMP=".claude/.rules-last-run"
SINCE=$(cat "$STAMP" 2>/dev/null || echo "")
# No stamp yet: look back a sensible window rather than all of history.
FROM="${SINCE:-$(date -v-6w +%Y-%m-%d 2>/dev/null || date -d '6 weeks ago' +%Y-%m-%d)}"

# One read of the PRs merged since the stamp. Best-effort: without gh or
# network, the count says so instead of reading as zero.
FIXES=$(gh pr list --state merged --search "merged:>=$FROM" --limit 200 \
  --json headRefName \
  --jq '[.[] | select(.headRefName | test("^(fix|security|sec|revert)/"))] | length' \
  2>/dev/null) || FIXES=""
case "$FIXES" in
  '' | *[!0-9]*) FIXES=0; FIX_NOTE="fix PRs unread: gh unavailable" ;;
  *) FIX_NOTE="$FIXES fix PRs merged" ;;
esac

LEDGER=0
if [ -f docs/RULE-FEEDBACK.md ]; then
  # Ledger entries are "### YYYY-MM-DD — ..."; count those dated after the stamp.
  LEDGER=$(grep -oE '^### [0-9]{4}-[0-9]{2}-[0-9]{2}' docs/RULE-FEEDBACK.md \
    | awk -v s="$FROM" '{ if (substr($2,1,10) > s) n++ } END { print n+0 }')
fi

SIGNAL=$(( FIXES + LEDGER ))

if [ "$SIGNAL" -ge "$THRESHOLD" ]; then
  cat <<MSG

─────────────────────────────────────────────────────────────────
  Rules improver: $SIGNAL signals since $FROM
    $FIX_NOTE + $LEDGER ledger entries  (threshold $THRESHOLD)

  Worth an observer pass:  /improve-rules
  It reads the accumulated evidence and proposes ONE focused edit to
  CLAUDE.md as a PR. "No change warranted" is a successful outcome.
─────────────────────────────────────────────────────────────────

MSG
else
  echo "Rules improver: $SIGNAL of $THRESHOLD signals since $FROM ($FIX_NOTE, $LEDGER ledger entries); no pass due yet."
fi

exit 0
