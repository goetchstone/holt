#!/bin/sh
# scripts/auto-import.sh
#
# Trigger automated the POS report import from Gmail.
# Configure this in Synology Task Scheduler as a recurring task
# (e.g., every 30 minutes during business hours, weekdays only).
#
# Required: AUTO_IMPORT_API_KEY must match the value in app/.env.local

AUTO_IMPORT_API_KEY="${AUTO_IMPORT_API_KEY:-}"

if [ -z "$AUTO_IMPORT_API_KEY" ]; then
  echo "ERROR: AUTO_IMPORT_API_KEY is not set"
  exit 1
fi

curl -sf -X POST \
  -H "Authorization: Bearer ${AUTO_IMPORT_API_KEY}" \
  http://localhost:3000/api/automations/gmail-import
