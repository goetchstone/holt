#!/usr/bin/env bash
# .claude/hooks/session-start-check.sh
#
# SessionStart hook: fires when a Claude session begins (or resumes).
#
# Only stdout reaches the session. A SessionStart hook's stderr is written to
# the transcript file and delivered to nobody (RULE-FEEDBACK 2026-11-05), so
# what someone has to act on goes to stdout: the state of the gates on main
# (rule 65) and expired CVE suppressions (rule 54). The ORIENT checklist is
# still on stderr, so sessions don't see it; that ledger entry leaves moving it
# to the next improver pass.
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

  echo ""
} >&2

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
      echo "WARNING: osv-scanner.toml has expired CVE suppression(s) (ignoreUntil < $TODAY):"
      echo "$EXPIRED" | sed 's/^/  - /'
      echo "  Re-verify the rationale against the current tree before renewing (rule 54)."
      echo "  See .claude/skills/dependency-sweep/SKILL.md."
    fi
  fi
fi

# One line per workflow that is red. A pushed or scheduled workflow is as green
# as its last run. A dynamic one (Dependabot, CodeQL) runs once per ecosystem or
# language, minutes apart, so its last run says nothing about the others: on
# 2026-11-02 Dependabot's npm job failed and its docker job then passed. Those
# are read as a count. Input is newest first, as `gh run list` gives it.
# Cancelled and unfinished runs say nothing either way.
red_workflows() {
  awk -F'\t' -v since="$1" '
    $2 != "success" && $2 != "failure" { next }
    !($1 in latest) {
      latest[$1] = $2; day[$1] = $4; run[$1] = $5
      dynamic[$1] = ($3 == "dynamic"); names[++n] = $1
    }
    { total[$1]++ }
    $2 == "failure" {
      if (!($1 in failed)) { failday[$1] = $4; failrun[$1] = $5 }
      failed[$1]++
    }
    END {
      for (i = 1; i <= n; i++) {
        w = names[i]
        if (dynamic[w] && (w in failed)) {
          printf "  RED: %s: %d of %d runs failed since %s, last on %s (run %s).\n", w, failed[w], total[w], since, failday[w], failrun[w]
        } else if (!dynamic[w] && latest[w] == "failure") {
          printf "  RED: %s: its last run on main failed, %s (run %s).\n", w, day[w], run[w]
        }
      }
    }'
}

# One line unless nothing is open. An answer that isn't a number is unread, not
# zero: a refused `gh api` prints the error body on stdout.
open_alerts() {
  COUNT="$(gh api "repos/{owner}/{repo}/$1/alerts?state=open&per_page=100" --jq 'length' 2>/dev/null || true)"
  case "$COUNT" in
    '' | *[!0-9]*) echo "  UNREAD: $2 alerts: gh could not read them (it takes an admin of the repository)." ;;
    0) ;;
    *) echo "  RED: $2 alerts open on main: $COUNT." ;;
  esac
}

# The gates on main (rule 65). A gate that fails into a log or a Security tab is
# a comment: Dependabot's update job failed 16 of its 42 runs on main, and three
# PRs' CodeQL checks passed while 11 high alerts landed on main.
# Prints every session, green too, and says UNREAD when gh can't answer, because
# silence is how the improver's broken count hid (RULE-FEEDBACK 2026-10-27).
report_gates() {
  cd "$REPO_ROOT" || return 0

  # Alerts are readable only by the repository's admins, and the active gh
  # account can be another project's. Read as the account that owns this
  # repository when it is logged in here.
  if [ -z "${GH_TOKEN:-}" ]; then
    OWNER="$(git remote get-url origin 2>/dev/null | sed -E 's#\.git$##; s#.*[:/]([^/]+)/[^/]+$#\1#')"
    TOKEN="$(gh auth token --user "$OWNER" 2>/dev/null || true)"
    if [ -n "$TOKEN" ]; then export GH_TOKEN="$TOKEN"; fi
  fi

  # A week: Dependabot and the scheduled Security, Scorecard and Markdown lint
  # runs are all weekly, so every workflow has a run inside it.
  SINCE="$(date -v-7d +%Y-%m-%d 2>/dev/null || date -d '7 days ago' +%Y-%m-%d 2>/dev/null || echo "")"
  RUNS="$(gh run list --branch main --created ">=$SINCE" --limit 500 \
    --json workflowName,conclusion,event,createdAt,databaseId \
    --jq '.[] | [.workflowName, .conclusion, .event, .createdAt[:10], .databaseId] | @tsv' \
    2>/dev/null || true)"

  if [ -z "$RUNS" ]; then
    RUN_LINES="  UNREAD: no workflow runs on main read since $SINCE."
    RUN_COUNT=0
  else
    RUN_LINES="$(printf '%s\n' "$RUNS" | red_workflows "$SINCE")"
    RUN_COUNT="$(printf '%s\n' "$RUNS" | wc -l | tr -d ' ')"
  fi

  PROBLEMS="$(
    if [ -n "$RUN_LINES" ]; then printf '%s\n' "$RUN_LINES"; fi
    open_alerts code-scanning CodeQL
    open_alerts dependabot Dependabot
  )"

  if [ -z "$PROBLEMS" ]; then
    echo "Gates on main (rule 65): green. $RUN_COUNT runs since $SINCE; no open CodeQL or Dependabot alerts."
  else
    echo "Gates on main (rule 65): not all green. Say so to the owner; each ends fixed, tripwire-tested or won't-fix with a reason (rule 48)."
    printf '%s\n' "$PROBLEMS"
  fi
}

(report_gates)

exit 0
