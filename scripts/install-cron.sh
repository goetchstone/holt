#!/usr/bin/env bash
# scripts/install-cron.sh
#
# Install/update/remove the recurring automation jobs (docs/PRODUCTION.md
# section 4, "Scheduled jobs (cron)") into the current user's crontab, so
# go-live doesn't depend on an operator hand-typing nine scheduler
# entries correctly. Idempotent: re-running rewrites a single delimited
# block rather than piling up duplicate entries.
#
# Backups ARE installed (scripts/backup-db.sh, backup-uploads.sh). They used
# to be excluded on the grounds that they have their own documented recipe in
# docs/DISASTER-RECOVERY.md with different retention/off-box concerns. That
# reasoning was sound and the outcome was not: a documented manual step at
# go-live is a step nobody performs, and an MVP audit found no scheduled
# backup anywhere. The retention/off-box concerns are handled by env
# (RETENTION_DAYS, BACKUP_REMOTE) instead of by omission.
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
# reference scheduler entries all run as `root`; on a plain cron host
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
# One line, on purpose. This wakes Holt every 5 minutes, and Holt decides what's due from
# the store's own settings at Admin > Automations (owner, 2026-11-06: "Any automation
# should be something the user can configure"). Whether a job runs, and when, is not a
# server's business. A host upgrading from the old per-job lines gets them replaced the
# next time this runs, since the whole managed block is rewritten.
JOBS=(
  "*/5 * * * *|auto-automations.sh|auto-automations.log|Nothing Holt automates runs by itself: no email or text goes out, invoices and password resets included, and the books and stock jobs stop"
)

# Backup jobs run the same managed block but need DATABASE/backup env rather
# than the automations' API key, so they carry their own export prefix.
# Scheduled before the automations' 02:00 traffic job to keep the nightly
# window uncontended.
BACKUP_JOBS=(
  "15 1 * * *|backup-db.sh|backup-db.log|NO DATABASE BACKUP IS TAKEN. A disk failure, a bad migration, or a mistaken delete becomes permanent loss of every order, payment and ledger entry."
  "45 1 * * *|backup-uploads.sh|backup-uploads.log|Uploaded files (proposals, product images, ticket attachments) are not backed up -- the database restores without them and rows point at missing files."
)

# --- Required env ------------------------------------------------------
# The automations authenticate to /api/automations/* with AUTO_IMPORT_API_KEY,
# so without it they cannot be installed. Backups do NOT use that key, and
# must not be held hostage to it: refusing everything when the key is missing
# is how a deployment ends up with no scheduled backup, which is the failure
# this script exists to prevent. So a missing key skips the automations and
# still installs the backups.
INSTALL_AUTOMATIONS=1
if [ "$UNINSTALL" -eq 0 ]; then
  if ! grep -qE '^AUTO_IMPORT_API_KEY=.+' "$ENV_FILE" 2>/dev/null && [ -z "${AUTO_IMPORT_API_KEY:-}" ]; then
    INSTALL_AUTOMATIONS=0
    echo "WARNING: AUTO_IMPORT_API_KEY is not set in $ENV_FILE (see env.example)." >&2
    echo "  Skipping the ${#JOBS[@]} automation job(s) -- they authenticate to" >&2
    echo "  /api/automations/* with it as a Bearer token." >&2
    echo "  Installing the ${#BACKUP_JOBS[@]} BACKUP job(s) anyway; those do not use it." >&2
    echo "  Re-run this script once the key is set to add the automations." >&2
  fi
fi

# --- Build the export prefix each job line sources from app/.env.local ----
# Re-reads the file at CRON RUN TIME (matches the pattern documented in
# docs/OPERATIONS.md's own Scheduler config blocks) rather than baking the
# secret value into the crontab text -- the crontab file itself never
# contains the key's actual value, only a command that fetches it fresh.
# Only exports the vars scripts/_cron-run.sh actually reads.
EXPORT_CMD="export \$(grep -E '^(AUTO_IMPORT_API_KEY|APP_BASE_URL|OPS_ALERT_WEBHOOK)=' \"$ENV_FILE\" 2>/dev/null)"

# Backups read database credentials and the off-host destination from the ROOT
# .env (where docker compose reads them), not app/.env.local. Same
# read-at-run-time approach so no secret is written into the crontab.
BACKUP_EXPORT_CMD="export \$(grep -E '^(POSTGRES_USER|POSTGRES_DB|BACKUP_DIR|BACKUP_REMOTE|BACKUP_REMOTE_CMD|RETENTION_DAYS)=' \"$REPO_ROOT/.env\" 2>/dev/null)"

build_block() {
  echo "$MARK_BEGIN"
  echo "# Managed by scripts/install-cron.sh -- do not hand-edit between the"
  echo "# markers, re-run the script instead. Regenerated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ "$INSTALL_AUTOMATIONS" -eq 1 ]; then
    for job in "${JOBS[@]}"; do
      IFS='|' read -r schedule script log consequence <<<"$job"
      echo "# $script -- if this stops running: $consequence"
      echo "$schedule cd \"$REPO_ROOT\" && $EXPORT_CMD && ./scripts/$script >> logs/$log 2>&1"
    done
  else
    echo "# Automations SKIPPED: AUTO_IMPORT_API_KEY was unset when this block"
    echo "# was generated. Set it and re-run scripts/install-cron.sh."
  fi
  echo "#"
  echo "# Backups. BACKUP_REMOTE is what makes these survive the host dying;"
  echo "# without it backup-db.sh warns on every run and the dump stays on the"
  echo "# same disk as the database it is protecting."
  for job in "${BACKUP_JOBS[@]}"; do
    IFS='|' read -r schedule script log consequence <<<"$job"
    echo "# $script -- if this stops running: $consequence"
    echo "$schedule cd \"$REPO_ROOT\" && $BACKUP_EXPORT_CMD && ./scripts/$script >> logs/$log 2>&1"
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
  if [ "$INSTALL_AUTOMATIONS" -eq 1 ]; then
    echo "OK -- installed/updated $(( ${#JOBS[@]} + ${#BACKUP_JOBS[@]} )) job(s) in the managed cron block."
  else
    echo "OK -- installed/updated ${#BACKUP_JOBS[@]} backup job(s). Automations skipped (no API key)."
  fi
  echo "Verify: crontab -l"
fi
