#!/usr/bin/env bash
# scripts/backfill-customer-names-from-csv.sh
#
# One-shot backfill: hydrate firstName/lastName on stuck anonymous
# Customer rows by joining against an the POS Customers CSV.
#
# When to run:
#   - You have stuck Customer rows (externalId set, NULL names, with
#     active orders) and the daily auto-import isn't filling them.
#   - PR #284's late-hydrate `findOrCreateCustomer` code IS deployed:
#     prefer the customer-import path. This script is the fast fix
#     when you want results NOW without waiting for the next cron.
#
# Safe / idempotent:
#   - Only touches rows that are currently NULL across firstName,
#     lastName, AND tradeCompanyName
#   - Skips CSV entries with "Cash Sale" / "Walk In" placeholder names
#   - Re-running is a no-op (matched rows are no longer NULL)
#
# Usage:
#   ./scripts/backfill-customer-names-from-csv.sh /path/to/SH_Customers.csv
#
# On Synology prod (typical):
#   ./scripts/backfill-customer-names-from-csv.sh /tmp/SH_Customers.csv
#
# Output: number of customer rows hydrated.

set -euo pipefail

CSV_PATH="${1:-}"
if [ -z "$CSV_PATH" ] || [ ! -f "$CSV_PATH" ]; then
  echo "Usage: $0 <path-to-customers-csv>" >&2
  echo "" >&2
  echo "The CSV must have columns: Cuscode, Customer, Address, Zip, Email" >&2
  exit 1
fi

CONTAINER="${DB_CONTAINER:-furniture-configurator-db-1}"
DB_USER="${DB_USER:-dbuser_fbc}"
DB_NAME="${DB_NAME:-fbc_prod_db}"
CONTAINER_CSV_PATH="/tmp/sh_customers_backfill.csv"

echo "Copying CSV into container..."
docker cp "$CSV_PATH" "${CONTAINER}:${CONTAINER_CSV_PATH}"

echo "Running backfill..."
docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" <<EOF
BEGIN;

CREATE TEMP TABLE csv_customers (
  cuscode TEXT,
  customer TEXT,
  address TEXT,
  zip TEXT,
  email TEXT
);

COPY csv_customers FROM '${CONTAINER_CSV_PATH}' WITH (FORMAT csv, HEADER true);

UPDATE "Customer" c
SET
  "firstName" = TRIM(split_part(csv.customer, ' ', 1)),
  "lastName"  = NULLIF(TRIM(substring(csv.customer FROM position(' ' IN csv.customer) + 1)), ''),
  updated     = NOW()
FROM csv_customers csv
JOIN "CustomerExternalId" co ON UPPER(csv.cuscode) = UPPER(co."externalId")
WHERE co."customerId" = c.id
  AND c."firstName" IS NULL
  AND c."lastName" IS NULL
  AND c."tradeCompanyName" IS NULL
  AND TRIM(COALESCE(csv.customer, '')) <> ''
  AND UPPER(TRIM(csv.customer)) NOT IN ('CASH SALE','WALK IN','WALK-IN');

COMMIT;

-- Report what was left after the run.
SELECT COUNT(*) AS still_anonymous
FROM "Customer" c
JOIN "CustomerExternalId" co ON co."customerId" = c.id
WHERE c."firstName" IS NULL AND c."lastName" IS NULL AND c."tradeCompanyName" IS NULL;
EOF

echo "Cleaning up..."
docker exec "$CONTAINER" rm -f "$CONTAINER_CSV_PATH"

echo "Done."
