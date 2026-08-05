#!/bin/sh
# scripts/auto-expire-stale-pending-payments.sh
#
# Sweeps PENDING payments whose hosted-checkout session is older than 24h
# (Stripe's own checkout-session lifetime) and marks them FAILED. The
# webhook's checkout.session.expired handling (pages/api/stripe/webhook.ts)
# catches most of these the moment the session actually expires, but
# webhooks get missed, and Square's Payment Links API has no expiry event
# at all (see lib/payments/squareProvider.ts) -- so this is the only thing
# that ever closes those rows out.
#
# Configure in cron / Synology Task Scheduler to run hourly. Unlike the
# once-daily jobs in this directory, a stale PENDING row sits there reading
# as "in progress" for as long as it survives, so this wants a short
# cadence rather than an overnight one.
#
# Required env: AUTO_IMPORT_API_KEY must match the value in app/.env.local.
# Optional env: APP_BASE_URL, OPS_ALERT_WEBHOOK (see scripts/_cron-run.sh).

DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
. "$DIR/_cron-run.sh"

run_cron "expire-stale-pending-payments" "/api/automations/expire-stale-pending-payments"
