#!/bin/sh
# scripts/auto-daily-reconciliation.sh
#
# Trigger the daily JE-vs-source reconciliation check. Reconciles the
# previous day (in America/New_York) by default — pass --date YYYY-MM-DD
# or --start/--end YYYY-MM-DD to override.
#
# Configure in Synology Task Scheduler as a recurring task. Recommended:
# daily at 02:00 ET (after the POS import cycle has typically
# finished landing yesterday's data, and before anyone is up to look at
# yesterday's JE).
#
# Required: AUTO_IMPORT_API_KEY must match the value in app/.env.local
# (same key used by auto-import.sh — they share the Bearer)
#
# Logs to logs/auto-daily-reconciliation.log on the NAS. Operator can
# also view per-run results at /admin/automations/daily-reconciliation
# in the web UI.

AUTO_IMPORT_API_KEY="${AUTO_IMPORT_API_KEY:-}"

if [ -z "$AUTO_IMPORT_API_KEY" ]; then
  echo "ERROR: AUTO_IMPORT_API_KEY is not set"
  exit 1
fi

# Default body is empty — endpoint reconciles yesterday (ET).
# To reconcile a range, pass JSON via stdin or use the admin UI.
BODY="${1:-{}}"

curl -sf -X POST \
  -H "Authorization: Bearer ${AUTO_IMPORT_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "${BODY}" \
  http://localhost:3000/api/automations/daily-reconciliation
