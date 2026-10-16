#!/usr/bin/env bash
# .claude/hooks/session-start-check.sh
#
# SessionStart hook: fires when a Claude session begins (or resumes).
# Surfaces the start-session ORIENT checklist (CLAUDE.md rule 36) so it
# stays top-of-mind from the first message.
#
# Always exit 0 -- informational only. Blocking session start is
# user-hostile, and every check below is best-effort: missing tooling
# (no git repo yet, unparseable dates) degrades to skipping that one section, never to a
# non-zero exit.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SKILL_PATH="$REPO_ROOT/.claude/skills/start-session/SKILL.md"

{
  echo ""
  echo "-- SESSION START -- ORIENT (CLAUDE.md rule 36) --"
  echo ""
  if [ -f "$SKILL_PATH" ]; then
    head -30 "$SKILL_PATH"
    echo ""
    echo "Run /start-session for the full checklist."
  fi

  # What changed since the previous session, if this is a git repo.
  if git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    LAST_COMMIT="$(git -C "$REPO_ROOT" log -1 --format='%cr -- %s' 2>/dev/null || echo "")"
    if [ -n "$LAST_COMMIT" ]; then
      echo ""
      echo "Last commit: $LAST_COMMIT"
    fi
    BRANCH="$(git -C "$REPO_ROOT" branch --show-current 2>/dev/null || echo "")"
    if [ -n "$BRANCH" ] && [ "$BRANCH" != "main" ]; then
      echo "Current branch: $BRANCH (not main -- confirm that's intentional)"
    fi
  fi

  # CVE suppression expiry (rule 54). Pure string comparison on
  # YYYY-MM-DD -- ISO dates sort lexicographically, so no date-arithmetic
  # portability problems between BSD date (macOS) and GNU date (Linux
  # CI). Skips silently if the file doesn't exist or has no ignoreUntil
  # lines.
  OSV_TOML="$REPO_ROOT/app/osv-scanner.toml"
  if [ -f "$OSV_TOML" ]; then
    TODAY="$(date +%Y-%m-%d 2>/dev/null || echo "")"
    if [ -n "$TODAY" ]; then
      EXPIRED=$(grep -oE 'ignoreUntil[[:space:]]*=[[:space:]]*[0-9]{4}-[0-9]{2}-[0-9]{2}' "$OSV_TOML" 2>/dev/null \
        | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' \
        | awk -v today="$TODAY" '$0 < today' || true)
      if [ -n "$EXPIRED" ]; then
        echo ""
        echo "WARNING: osv-scanner.toml has expired CVE suppression(s) (ignoreUntil < $TODAY):"
        echo "$EXPIRED" | sed 's/^/  - /'
        echo "  Re-verify the rationale against the current tree before renewing (rule 54)."
        echo "  See .claude/skills/dependency-sweep/SKILL.md."
      fi
    fi
  fi

  echo ""
} >&2

exit 0
