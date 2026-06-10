#!/bin/sh
# scripts/auto-customer-ar-drift-check.sh
#
# Daily customer AR-drift check — cross-checks stored
# `Customer.openArBalance` against the live source-of-truth recompute
# for every customer with payment or ledger activity in the last 26
# hours. Drift > $0.005 is logged to the response and surfaced via the
# /admin/automations dashboard.
#
# Configure in cron / Synology Task Scheduler to run daily at 04:30
# (before mailchimp-sync + lead-housekeeping at 05:00; the AR data should
# be quiet at this hour so the snapshot is consistent).
#
# Required env: AUTO_IMPORT_API_KEY must match the value in app/.env.local.
# Optional env: APP_BASE_URL, OPS_ALERT_WEBHOOK (see scripts/_cron-run.sh) —
# a failed check now fires an ops alert.

DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
. "$DIR/_cron-run.sh"

run_cron "customer-ar-drift-check" "/api/automations/customer-ar-drift-check"
