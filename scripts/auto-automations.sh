#!/bin/sh
# scripts/auto-automations.sh
#
# Wakes Holt. This is the only thing a host's scheduler runs for the application, every
# 5 minutes (scripts/install-cron.sh). Holt decides what's due from the store's own
# settings at Admin > Automations, so whether a job runs, and when, is never set here.
#
# Needs AUTO_IMPORT_API_KEY. APP_BASE_URL defaults to http://localhost:3000.

DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
. "$DIR/_cron-run.sh"
run_cron "automations" "/api/automations/tick"
