#!/bin/sh
# scripts/auto-customer-ar-drift-check.sh
#
# Daily customer AR-drift check — cross-checks stored
# `Customer.openArBalance` against the live source-of-truth recompute
# for every customer with payment or ledger activity in the last 26
# hours. Drift > $0.005 is logged to the response and surfaced via the
# /admin/automations dashboard (follow-up PR).
#
# Configure in Synology Task Scheduler to run daily at 04:30
# (before mailchimp-sync at 05:00 and lead-housekeeping at 05:00; the
# AR data should be quiet at this hour so the snapshot is consistent).
#
# Required env: AUTO_IMPORT_API_KEY must match the value in app/.env.local

AUTO_IMPORT_API_KEY="${AUTO_IMPORT_API_KEY:-}"

if [ -z "$AUTO_IMPORT_API_KEY" ]; then
  echo "ERROR: AUTO_IMPORT_API_KEY is not set"
  exit 1
fi

curl -sf -X POST \
  -H "Authorization: Bearer ${AUTO_IMPORT_API_KEY}" \
  http://localhost:3000/api/automations/customer-ar-drift-check
