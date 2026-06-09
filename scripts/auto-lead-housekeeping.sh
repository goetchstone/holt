#!/bin/sh
# scripts/auto-lead-housekeeping.sh
#
# Nightly lead aging — auto-archives NEW/ASSIGNED leads that have been
# silent for 30 days. Pinned leads and leads whose customer has an active
# QUOTE are exempt. Configure in Synology Task Scheduler to run daily at
# 05:00 (before business hours).
#
# Required: AUTO_IMPORT_API_KEY must match the value in app/.env.local

AUTO_IMPORT_API_KEY="${AUTO_IMPORT_API_KEY:-}"

if [ -z "$AUTO_IMPORT_API_KEY" ]; then
  echo "ERROR: AUTO_IMPORT_API_KEY is not set"
  exit 1
fi

curl -sf -X POST \
  -H "Authorization: Bearer ${AUTO_IMPORT_API_KEY}" \
  http://localhost:3000/api/automations/lead-housekeeping
