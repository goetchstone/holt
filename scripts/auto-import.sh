#!/bin/sh
# scripts/auto-import.sh
#
# Trigger this deployment's source import -- whichever SourceAdapter is
# selected in Settings -> Configuration -> Source System. For an Ordorite
# deployment that is Gmail -> CSV reports -> import runners; for a deployment
# with no source system it is a no-op that reports so, rather than a failure.
# Configure in cron / Synology Task Scheduler as a recurring task — daily at
# 06:10 local is the proven cadence (the legacy POS emails prior-day batch
# reports overnight; several import quirks assume a full day's sales+returns
# arrive in one batch, so run once per day, never split a day's files).
#
# An adapter that names a module flag (Ordorite names `legacyPosImport`)
# still needs that flag ON; with it off, the run reports nothing to import
# instead of failing.
# Required env: AUTO_IMPORT_API_KEY (matches app/.env.local).
# Optional env: APP_BASE_URL, OPS_ALERT_WEBHOOK (see scripts/_cron-run.sh) —
# a failed run now fires an ops alert.

DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
. "$DIR/_cron-run.sh"

# The old /api/automations/gmail-import path still works and forwards here,
# so an un-updated crontab on a deployed box keeps running.
run_cron "source-import" "/api/automations/source-import"
