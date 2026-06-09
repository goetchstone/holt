#!/bin/sh
# scripts/auto-axper-traffic.sh
#
# Pull yesterday's Axper traffic data into TrafficSnapshot and
# auto-backfill any gaps in the last 30 days. Configure in Synology
# Task Scheduler as a recurring task.
#
# Recommended schedule: daily at 02:00 ET. Axper closes the day at
# midnight local; by 02:00 the previous day's intervals are final
# and nobody is querying the dashboard yet.
#
# Required: AUTO_IMPORT_API_KEY must match the value in app/.env.local
# (same key used by auto-import.sh + auto-daily-reconciliation.sh).
#
# Logs to logs/auto-axper-traffic.log on the NAS. Operator can also
# view per-run results at /admin/automations/axper-traffic in the
# web UI.

AUTO_IMPORT_API_KEY="${AUTO_IMPORT_API_KEY:-}"

if [ -z "$AUTO_IMPORT_API_KEY" ]; then
  echo "ERROR: AUTO_IMPORT_API_KEY is not set"
  exit 1
fi

# Default body is empty — endpoint pulls yesterday + backfills 30 days.
# To override the backfill window: scripts/auto-axper-traffic.sh '{"backfillWindowDays":60}'
BODY="${1:-{}}"

curl -sf -X POST \
  -H "Authorization: Bearer ${AUTO_IMPORT_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "${BODY}" \
  http://localhost:3000/api/automations/axper-traffic-sync
