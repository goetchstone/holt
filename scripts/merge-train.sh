#!/usr/bin/env bash
# scripts/merge-train.sh
#
# Merge a queue of PRs in order, one at a time, waiting for CI on each.
#
# Why this exists: the branch-protection ruleset requires a PR to be up to date
# with main before it can merge, and every merge advances main. So a batch of
# ready PRs cannot be merged in parallel — each one has to be updated, re-tested
# and merged before the next becomes mergeable. Doing that by hand is a long
# sequence of poll-and-wait that is easy to get wrong halfway through.
#
# It stops at the first failure rather than skipping ahead, because a red PR
# usually means main moved under it and the ones behind it will fail the same
# way — better to look once than to churn through the whole queue.
#
# Usage:
#   scripts/merge-train.sh 42 44 46           # merge in this order
#   DRY_RUN=1 scripts/merge-train.sh 42 44    # report only, never merge
#
# Requires: gh, authenticated. Set GH_TOKEN to pin the account when another
# session might switch the active gh profile out from under you.

set -euo pipefail

REPO="${REPO:-goetchstone/holt}"
GH="${GH:-gh}"
POLL_SECONDS="${POLL_SECONDS:-20}"
MAX_POLLS="${MAX_POLLS:-45}"
DRY_RUN="${DRY_RUN:-0}"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <pr-number> [pr-number ...]" >&2
  exit 64
fi

command -v "$GH" >/dev/null 2>&1 || { echo "gh not found on PATH (set GH=/path/to/gh)" >&2; exit 69; }

# Required checks only. Other checks (markdown lint, weekly image scans) can be
# absent or skipped without blocking a merge, so gating on "everything green"
# would stall the train on jobs that never run for this PR.
required_checks() {
  "$GH" pr view "$1" -R "$REPO" --json statusCheckRollup --jq \
    '.statusCheckRollup[] | select(.name=="Lint, Typecheck, Format, Test" or .name=="Dependency CVE scan" or .name=="Semgrep static analysis")'
}

for pr in "$@"; do
  echo "=== PR #$pr ==="

  # Bring the branch up to date with main. A no-op when already current; the
  # ruleset rejects the merge otherwise.
  #
  # Skipped under DRY_RUN: updating a branch pushes a merge commit and retriggers
  # CI, which is a real mutation. A dry run that writes is not a dry run.
  if [ "$DRY_RUN" = "1" ]; then
    echo "  (DRY_RUN: skipping update-branch; reporting current check state)"
  else
    "$GH" api -X PUT "repos/$REPO/pulls/$pr/update-branch" >/dev/null 2>&1 || true
    sleep 25   # let the merge commit register and CI enqueue
  fi

  polls=0
  while [ "$polls" -lt "$MAX_POLLS" ]; do
    pending=$("$GH" pr view "$pr" -R "$REPO" --json statusCheckRollup --jq \
      '[.statusCheckRollup[] | select((.conclusion // "") == "" and .status != "COMPLETED")] | length' 2>/dev/null || echo 1)
    [ "$pending" = "0" ] && break
    polls=$((polls + 1))
    sleep "$POLL_SECONDS"
  done

  if [ "$polls" -ge "$MAX_POLLS" ]; then
    echo "  #$pr: timed out waiting for checks; stopping" >&2
    exit 75
  fi

  required_checks "$pr" | "${JQ:-jq}" -r '"  \(.name): \(.conclusion // .status)"'

  failed=$("$GH" pr view "$pr" -R "$REPO" --json statusCheckRollup --jq \
    '[.statusCheckRollup[] | select(.conclusion=="FAILURE")] | length')

  if [ "$failed" != "0" ]; then
    echo "  #$pr has failing checks; stopping the train" >&2
    echo "  (a fresh CVE advisory is the usual cause — land a dependency sweep first, then re-run)" >&2
    exit 1
  fi

  if [ "$DRY_RUN" = "1" ]; then
    echo "  #$pr would merge (DRY_RUN=1)"
    continue
  fi

  "$GH" pr merge "$pr" -R "$REPO" --squash --delete-branch
  echo "  #$pr merged"
done

echo "=== train complete ==="
