#!/bin/sh
# scripts/auto-mailchimp-customer-sync.sh
#
# Pushes new ERP customers (with email, created on/after the backfill
# cutoff, not yet synced) into the configured Mailchimp audience as
# PENDING (double opt-in). Idempotent -- safe to run repeatedly.
#
# Schedule: once daily via Synology Task Scheduler. Cap of 200 contacts
# per run is enforced server-side; if the backfill is large, schedule
# multiple runs spaced an hour apart for the first few days.
#
# Required: AUTO_IMPORT_API_KEY must match the value in app/.env.local

AUTO_IMPORT_API_KEY="${AUTO_IMPORT_API_KEY:-}"

if [ -z "$AUTO_IMPORT_API_KEY" ]; then
  echo "ERROR: AUTO_IMPORT_API_KEY is not set"
  exit 1
fi

curl -sf -X POST \
  -H "Authorization: Bearer ${AUTO_IMPORT_API_KEY}" \
  http://localhost:3000/api/automations/mailchimp-customer-sync
