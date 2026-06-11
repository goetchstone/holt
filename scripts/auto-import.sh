#!/bin/sh
# scripts/auto-import.sh
#
# Trigger the legacy-POS auto-import (Gmail -> CSV reports -> import runners).
# Configure in cron / Synology Task Scheduler as a recurring task — daily at
# 06:10 local is the proven cadence (the legacy POS emails prior-day batch
# reports overnight; several import quirks assume a full day's sales+returns
# arrive in one batch, so run once per day, never split a day's files).
#
# Requires the `legacyPosImport` feature flag ON for this deployment.
# Required env: AUTO_IMPORT_API_KEY (matches app/.env.local).
# Optional env: APP_BASE_URL, OPS_ALERT_WEBHOOK (see scripts/_cron-run.sh) —
# a failed run now fires an ops alert.

DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
. "$DIR/_cron-run.sh"

run_cron "legacy-pos-import" "/api/automations/gmail-import"
