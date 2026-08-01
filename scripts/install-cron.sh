#!/usr/bin/env bash
# scripts/install-cron.sh
#
# Install/update/remove the recurring automation jobs (docs/PRODUCTION.md
# section 4, "Scheduled jobs (cron)") into the current user's crontab, so
# go-live doesn't depend on an operator hand-typing nine Task Scheduler
# entries correctly. Idempotent: re-running rewrites a single delimited
# block rather than piling up duplicate entries.
#
# What this does NOT install: scripts/backup-db.sh / backup-uploads.sh.
# Those have their own documented cron recipe in docs/DISASTER-RECOVERY.md
# (different retention/off-box concerns) and aren't part of the
# auto-*.sh job family this script manages -- see docs/PRODUCTION.md
# section 4 vs section 3.
#
# Usage:
#   ./scripts/install-cron.sh              Install/update the managed block
#   ./scripts/install-cron.sh --dry-run    Print the crontab that WOULD be
#                                           installed; changes nothing
#   ./scripts/install-cron.sh --uninstall  Remove the managed block only
#
# Required env: AUTO_IMPORT_API_KEY must be set in app/.env.local (see
# env.example) -- every job authenticates to /api/automations/* with it as
# a Bearer token. Refused up front for --install/--dry-run (not required
# for --uninstall, which only removes entries).
#
# Optional env, exported into each job's cron line if present in
# app/.env.local: APP_BASE_URL, OPS_ALERT_WEBHOOK (see scripts/_cron-run.sh
# for what these change).
#
# Run this as whichever user should own the jobs -- docs/OPERATIONS.md's
# reference Task Scheduler entries all run as `root`; on a plain cron host
# that typically means `sudo ./scripts/install-cron.sh`.

set -euo pipefail

REPO_ROOT=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
ENV_FILE="$REPO_ROOT/app/.env.local"
MARK_BEGIN="# >>> holt cron >>>"
MARK_END="# <<< holt cron <<<"

usage() {
  echo "Usage: $0 [--dry-run | --uninstall]" >&2
  exit 1
}

DRY_RUN=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h | --help) usage ;;
    *)
      echo "ERROR: unrecognized argument '$arg'" >&2
      usage
      ;;
  esac
done
if [ "$DRY_RUN" -eq 1 ] && [ "$UNINSTALL" -eq 1 ]; then
  echo "ERROR: --dry-run and --uninstall are mutually exclusive." >&2
  exit 1
fi

# --- Job manifest ----------------------------------------------------------
# schedule|script|log-file|consequence-if-this-never-runs
#
# Schedules are taken from docs/OPERATIONS.md's "Scheduled Tasks at a
# Glance" table (the one consolidated, chronologically-ordered reference),
# which is what this script treats as authoritative. Three of the nine had
# a SECOND, conflicting cadence written down elsewhere in the docs/scripts
# (noted job-by-job below) -- flagged here rather than silently picked:
#   - auto-customer-ar-drift-check.sh: the table says 04:45; the script's
#     own header comment and the OPERATIONS.md prose section both say
#     04:30. Went with the table (04:45); reconcile the other two if 04:30
#     was actually intended.
#   - auto-mailchimp-sync.sh: the table says 05:30 (after lead-housekeeping
#     at 05:00); the script's own header comment says "e.g. 04:30, before
#     lead-housekeeping" -- the opposite order. Went with the table
#     (05:30), since the detailed OPERATIONS.md section gives an explicit
#     ordering rationale ("after lead-housekeeping... before import") that
#     the one-line script comment doesn't.
#   - auto-daily-reconciliation.sh: the table says 22:30; the script's own
#     header comment recommends 02:00 ("after the import cycle... before
#     anyone is up to look at yesterday's JE"). These aren't a
#     15-minute rounding difference like the other two -- they're 20+
#     hours apart and imply different intents (previous evening's close-out
#     vs. next morning's post-import check). Went with the table (22:30) as
#     the more actively consolidated source, but this one most needs a
#     human to confirm which was actually meant.
# None of these three are invented from nothing -- every job has a stated
# cadence somewhere in the docs. Where this script differs from an
# in-repo doc, it's a resolved conflict, not a fabrication.
JOBS=(
  "*/5 * * * *|auto-email-queue.sh|auto-email-queue.log|Every invoice delivery, booking confirmation, ticket reply, and password-reset email silently never sends -- queued messages sit PENDING forever. Highest-frequency job in the system."
  "45 4 * * *|auto-customer-ar-drift-check.sh|auto-customer-ar-drift-check.log|Books silently drift from the source-of-truth ledger recompute -- AR discrepancies go undetected until someone stumbles on them or a customer disputes a balance."
  "30 22 * * *|auto-daily-reconciliation.sh|auto-daily-reconciliation.log|JE-vs-source mismatches accumulate with nobody alerted -- the day's books don't tie out and it isn't caught until someone looks by hand."
  "30 4 * * 0|auto-customer-level-recalc.sh|auto-customer-level-recalc.log|Customer.customerLevel/lifetimeSpend/customerGroup go stale -- leveling-dependent pricing and marketing logic keeps acting on outdated tiers indefinitely (weekly job, so the staleness compounds for a week at a time)."
  "0 5 * * *|auto-lead-housekeeping.sh|auto-lead-housekeeping.log|Stale NEW/ASSIGNED leads never auto-archive -- the leads board fills with 30+ day dead leads and buries the live ones."
  "30 5 * * *|auto-mailchimp-sync.sh|auto-mailchimp.log|Campaign/metrics/activity data goes stale and eligible engagement never converts into leads."
  "10 6 * * *|auto-import.sh|auto-import.log|POS/ERP daily CSV reports never import -- sales/inventory data silently stops updating from the source system. Only relevant where the legacyPosImport feature flag is on."
  "30 6 * * *|auto-mailchimp-customer-sync.sh|auto-mailchimp-customer-sync.log|New customers never get pushed to the Mailchimp audience -- the audience silently falls further behind the real customer list every day."
  "0 2 * * *|auto-axper-traffic.sh|auto-axper-traffic.log|Door-counter traffic snapshots stop landing -- TrafficSnapshot gaps grow and traffic reporting goes blank/stale. Only relevant where a door-counter integration is configured."
)

# --- Required env ------------------------------------------------------
if [ "$UNINSTALL" -eq 0 ]; then
  if ! grep -qE '^AUTO_IMPORT_API_KEY=.+' "$ENV_FILE" 2>/dev/null && [ -z "${AUTO_IMPORT_API_KEY:-}" ]; then
    echo "ERROR: AUTO_IMPORT_API_KEY is not set." >&2
    echo "  Set it in $ENV_FILE (see env.example) -- every cron job authenticates" >&2
    echo "  to /api/automations/* with it as a Bearer token. Nothing to install" >&2
    echo "  without it." >&2
    exit 1
  fi
fi

# --- Build the export prefix each job line sources from app/.env.local ----
# Re-reads the file at CRON RUN TIME (matches the pattern documented in
# docs/OPERATIONS.md's own Scheduler config blocks) rather than baking the
# secret value into the crontab text -- the crontab file itself never
# contains the key's actual value, only a command that fetches it fresh.
# Only exports the vars scripts/_cron-run.sh actually reads.
EXPORT_CMD="export \$(grep -E '^(AUTO_IMPORT_API_KEY|APP_BASE_URL|OPS_ALERT_WEBHOOK)=' \"$ENV_FILE\" 2>/dev/null)"

build_block() {
  echo "$MARK_BEGIN"
  echo "# Managed by scripts/install-cron.sh -- do not hand-edit between the"
  echo "# markers, re-run the script instead. Regenerated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  for job in "${JOBS[@]}"; do
    IFS='|' read -r schedule script log consequence <<<"$job"
    echo "# $script -- if this stops running: $consequence"
    echo "$schedule cd \"$REPO_ROOT\" && $EXPORT_CMD && ./scripts/$script >> logs/$log 2>&1"
  done
  echo "$MARK_END"
}

# --- Strip any existing managed block (idempotency) ------------------------
strip_managed_block() {
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
    $0==b {skip=1; next}
    $0==e {skip=0; next}
    skip {next}
    {print}
  '
}

CURRENT_CRONTAB=$(crontab -l 2>/dev/null || true)
STRIPPED=$(printf '%s\n' "$CURRENT_CRONTAB" | strip_managed_block)

if [ "$UNINSTALL" -eq 1 ]; then
  NEW_CRONTAB="$STRIPPED"
  echo "Removing the managed holt cron block."
else
  BLOCK=$(build_block)
  NEW_CRONTAB=$(printf '%s\n\n%s\n' "$STRIPPED" "$BLOCK")
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "=== --dry-run: crontab that WOULD be installed (nothing changed) ==="
  printf '%s\n' "$NEW_CRONTAB"
  exit 0
fi

mkdir -p "$REPO_ROOT/logs"
printf '%s\n' "$NEW_CRONTAB" | crontab -

if [ "$UNINSTALL" -eq 1 ]; then
  echo "OK -- managed cron block removed."
else
  echo "OK -- installed/updated ${#JOBS[@]} job(s) in the managed cron block."
  echo "Verify: crontab -l"
fi
