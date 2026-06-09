#!/bin/bash
# scripts/reimport-invoices.sh
#
# Re-imports historical invoices from a combined JSON file.
# Splits into batches and POSTs each to the invoice import API.
# Run from the repo root on the NAS after deploying.
#
# Usage:
#   ./scripts/reimport-invoices.sh /path/to/combined_invoices.json
#
# The JSON file should be an array of objects with columns:
#   "Invoice Date", "Invoice No", "Part No", "Memo",
#   "Product/Service Quantity", "Product/Service Sales Tax", "Tax Amount"

set -e

INPUT_FILE="${1:-/tmp/combined_invoices.json}"
API_URL="${API_URL:-http://localhost:3000/api/POS/import/invoices}"
BATCH_SIZE=5000

if [ ! -f "$INPUT_FILE" ]; then
  echo "File not found: $INPUT_FILE"
  exit 1
fi

TOTAL=$(python3 -c "import json; print(len(json.load(open('$INPUT_FILE'))))")
echo "Total rows: $TOTAL"
echo "Batch size: $BATCH_SIZE"
echo "API URL: $API_URL"

BATCHES=$(( (TOTAL + BATCH_SIZE - 1) / BATCH_SIZE ))
echo "Batches: $BATCHES"
echo ""

for i in $(seq 0 $((BATCHES - 1))); do
  START=$((i * BATCH_SIZE))
  echo -n "Batch $((i + 1))/$BATCHES (rows $START-$((START + BATCH_SIZE)))... "

  python3 -c "
import json, sys
data = json.load(open('$INPUT_FILE'))
batch = data[$START:$START+$BATCH_SIZE]
json.dump(batch, sys.stdout)
" | curl -s -X POST "$API_URL" \
    -H "Content-Type: application/json" \
    -H "Cookie: $(cat /tmp/session_cookie 2>/dev/null || echo '')" \
    -d @- \
    -o /tmp/invoice_batch_result.json \
    -w "HTTP %{http_code}"

  echo ""
  cat /tmp/invoice_batch_result.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'  Created: {d.get(\"invoicesCreated\",0)}, Updated: {d.get(\"invoicesUpdated\",0)}, Promoted: {d.get(\"ordersPromoted\",0)}, Not Found: {d.get(\"ordersNotFound\",0)}')" 2>/dev/null || echo "  (could not parse response)"
  echo ""
done

echo "Done!"
