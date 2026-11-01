#!/bin/sh
# scripts/auto-expire-quote-holds.sh
#
# Puts back on sale the stock of quotes whose holds have run out (GAP-16). A
# quote holds a floor-stock line for its customer through a chosen day; a
# quote nobody touches again has nothing else to release its stock, so
# without this the piece stays off the floor indefinitely.
#
# Configure in cron (or your host's task scheduler) to run hourly. A hold ends
# at the end of its day in the store's time zone, and an hourly run puts the
# piece back on sale within the hour after that.
#
# Required env: AUTO_IMPORT_API_KEY must match the value in app/.env.local.
# Optional env: APP_BASE_URL, OPS_ALERT_WEBHOOK (see scripts/_cron-run.sh).

DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
. "$DIR/_cron-run.sh"

run_cron "expire-quote-holds" "/api/automations/expire-quote-holds"
