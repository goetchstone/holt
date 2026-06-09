#!/bin/sh
# scripts/auto-customer-level-recalc.sh
#
# Weekly customer-level recalc — refreshes Customer.customerLevel /
# lifetimeSpend / lifetimeOrderCount / customerGroup / peakCustomerLevel
# using department-group-aware windows (see lib/customerLeveling.ts).
# Configure in Synology Task Scheduler to run weekly Sunday at 04:30
# (before lead-housekeeping at 05:00 so downstream jobs see fresh levels).
#
# Required: AUTO_IMPORT_API_KEY must match the value in app/.env.local

AUTO_IMPORT_API_KEY="${AUTO_IMPORT_API_KEY:-}"

if [ -z "$AUTO_IMPORT_API_KEY" ]; then
  echo "ERROR: AUTO_IMPORT_API_KEY is not set"
  exit 1
fi

curl -sf -X POST \
  -H "Authorization: Bearer ${AUTO_IMPORT_API_KEY}" \
  http://localhost:3000/api/automations/customer-level-recalc
