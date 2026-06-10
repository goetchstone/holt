#!/bin/sh
# scripts/auto-daily-reconciliation.sh
#
# Trigger the daily JE-vs-source reconciliation check. Reconciles the
# previous day (in the configured timezone) by default — pass a JSON body
# as the first argument (e.g. '{"date":"2026-06-09"}') to override.
#
# Configure in cron / Synology Task Scheduler as a recurring task. Recommended:
# daily at 02:00 local (after the import cycle has typically finished landing
# yesterday's data, and before anyone is up to look at yesterday's JE).
#
# Required env: AUTO_IMPORT_API_KEY must match the value in app/.env.local.
# Optional env: APP_BASE_URL, OPS_ALERT_WEBHOOK (see scripts/_cron-run.sh) —
# a failed reconcile (books don't tie out) now fires an ops alert.
#
# Logs to logs/auto-daily-reconciliation.log. Operator can also view per-run
# results at /admin/automations/daily-reconciliation in the web UI.

DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
. "$DIR/_cron-run.sh"

# Default body is empty object — endpoint reconciles yesterday.
BODY="${1:-{}}"

run_cron "daily-reconciliation" "/api/automations/daily-reconciliation" "$BODY"
