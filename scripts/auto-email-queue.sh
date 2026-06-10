#!/bin/sh
# scripts/auto-email-queue.sh
#
# Drains the durable email queue. WITHOUT this cron, every queued message —
# invoice delivery, booking + ticket confirmations, password-reset links —
# stays PENDING forever and never sends. This is the highest-frequency cron in
# the system.
#
# Configure in cron / Synology Task Scheduler to run every ~5 minutes.
# Required env: AUTO_IMPORT_API_KEY (matches app/.env.local).
# Optional env: APP_BASE_URL, OPS_ALERT_WEBHOOK (see scripts/_cron-run.sh).

DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
. "$DIR/_cron-run.sh"

run_cron "email-queue" "/api/automations/email-queue"
