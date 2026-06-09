#!/bin/sh
# scripts/auto-mailchimp-sync.sh
#
# Pulls new Mailchimp campaigns, metrics, and recent open/click activity,
# then converts eligible activity into leads. Configure in Synology Task
# Scheduler to run once daily (e.g. 04:30, before the lead-housekeeping job).
#
# Required: AUTO_IMPORT_API_KEY must match the value in app/.env.local

AUTO_IMPORT_API_KEY="${AUTO_IMPORT_API_KEY:-}"

if [ -z "$AUTO_IMPORT_API_KEY" ]; then
  echo "ERROR: AUTO_IMPORT_API_KEY is not set"
  exit 1
fi

curl -sf -X POST \
  -H "Authorization: Bearer ${AUTO_IMPORT_API_KEY}" \
  http://localhost:3000/api/automations/mailchimp-sync
