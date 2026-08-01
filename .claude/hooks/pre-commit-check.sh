#!/usr/bin/env bash
# .claude/hooks/pre-commit-check.sh
#
# PreToolUse hook: fires before `Bash(git commit*)` invocations.
# Surfaces the pre-commit checklist as a reminder.
#
# Behavior:
#   - Always informational (exit 0) for `git commit`. Show the checklist
#     every time so it stays top-of-mind, not "block every commit until
#     acknowledged" (that would slow legitimate small commits to a crawl).
#   - HARD BLOCKS (exit 2) when the commit message starts with `fix(`
#     (or `fix:`) AND the failure log hasn't been touched in the last
#     hour. Per CLAUDE.md rule 48 (every finding/fix has a terminal
#     state), a production-bug fix needs a failure log entry.
#
# Degrades gracefully: if python3 is missing, the JSON parse falls back to
# a permissive default and the hook stays informational-only rather than
# hard-failing a fresh clone that hasn't set up tooling yet.
#
# Tool input is delivered on stdin as JSON; we read the bash command from
# `tool_input.command`.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SKILL_PATH="$REPO_ROOT/.claude/skills/pre-commit/SKILL.md"
FAILURE_LOG="$REPO_ROOT/.claude/skills/post-failure/SKILL.md"

# Read tool input JSON from stdin. If python3 isn't available, degrade to
# "no command extracted" -- the hook then just skips (informational-only
# tools should never hard-fail because optional tooling is missing).
INPUT="$(cat)"
COMMAND=""
if command -v python3 >/dev/null 2>&1; then
  COMMAND="$(printf '%s' "$INPUT" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('tool_input', {}).get('command', ''))" 2>/dev/null || echo "")"
fi

# Match git commit invocations only. Anchored to a real command position
# (start-of-string or after a ; && || separator), optionally preceded by
# env assignments (VAR=value git commit ...). Deliberately NOT "git commit
# anywhere", which would also match the words inside a quoted string.
if [ -z "$COMMAND" ] || ! printf '%s' "$COMMAND" \
  | grep -qE '(^|[;&|][[:space:]]*)([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*git[[:space:]]+commit([[:space:]]|$)'; then
  exit 0
fi

# Extract the commit message if present. Best-effort: -m/-am, either quote
# style. Falls back to empty (the whole-command grep below still catches
# the heredoc form).
MSG="$(printf '%s' "$COMMAND" | grep -oE -- '-a?m "[^"]*"' | head -1 | sed -E 's/^-a?m "//; s/"$//')"
if [ -z "$MSG" ]; then
  MSG="$(printf '%s' "$COMMAND" | grep -oE -- "-a?m '[^']*'" | head -1 | sed -E "s/^-a?m '//; s/'\$//")"
fi

# Always emit the checklist as a non-blocking reminder.
{
  echo ""
  echo "-- PRE-COMMIT CHECKLIST (CLAUDE.md rule 48) --"
  echo ""
  if [ -f "$SKILL_PATH" ]; then
    head -40 "$SKILL_PATH"
    echo ""
    echo "(Full checklist: $SKILL_PATH)"
  else
    echo "NOTE: pre-commit skill missing at $SKILL_PATH"
  fi
  echo ""
} >&2

# HARD BLOCK only if this looks like a bug-fix commit without a recent
# failure log touch. Detection searches the WHOLE command (not just the
# parsed -m value) so the heredoc commit form this repo's own instructions
# use (`git commit -m "$(cat <<'EOF' ... EOF)"`) is still caught.
if printf '%s\n%s' "$MSG" "$COMMAND" | grep -qE '(^|["'"'"'[:space:]])fix[(:]'; then
  if [ -f "$FAILURE_LOG" ]; then
    NOW=$(date +%s 2>/dev/null || echo 0)
    LOG_MTIME=$(stat -f %m "$FAILURE_LOG" 2>/dev/null || stat -c %Y "$FAILURE_LOG" 2>/dev/null || echo "$NOW")
    LOG_AGE_SEC=$(( NOW - LOG_MTIME ))
    if [ "$LOG_AGE_SEC" -gt 3600 ]; then
      cat <<EOF >&2
======================================================================
  BLOCKED: bug-fix commit without recent failure log update.

  Commit message: $MSG
  Failure log last modified: ${LOG_AGE_SEC}s ago (> 1 hour)

  CLAUDE.md rule 48 expects a failure log entry for a production bug fix.
  Add one to:
      $FAILURE_LOG

  with: symptom, cause, why not caught, fix, prevention.

  After updating the failure log, re-run the commit.

  To bypass for a non-production-bug fix(): include "no-failure-log:" in
  the commit message body.
======================================================================
EOF
      if printf '%s' "$MSG" | grep -qE 'no-failure-log:'; then
        echo "(Bypass acknowledged via 'no-failure-log:' marker. Proceeding.)" >&2
        exit 0
      fi
      exit 2
    fi
  fi
fi

exit 0
