#!/usr/bin/env bash
# /app/scripts/run-integration-tests.sh
#
# Run integration tests one file at a time, in separate Jest
# invocations.
#
# Why per-file: TRUNCATE on 117 tables (resetTestDb) holds ACCESS
# EXCLUSIVE locks. With multiple test files in one Jest worker, the
# beforeEach TRUNCATE in file B can deadlock against a connection
# that's still releasing from file A's last test. Per-file invocation
# gives each file its own pg.Pool and its own clean exit.
#
# Each file's globalSetup is a no-op the second time onward (the test
# DB exists + the schema is in sync), so the per-file overhead is
# negligible (~200ms each on top of the test runtime).

set -e

cd "$(dirname "$0")/.."

# Glob all .integration.test.ts files; sort for deterministic order.
FILES=$(find __tests__/integration -name "*.integration.test.ts" -type f | sort)

if [ -z "$FILES" ]; then
  echo "No integration test files found under __tests__/integration/"
  exit 0
fi

FAILED=0
for file in $FILES; do
  echo ""
  echo "=== $file ==="
  if ! node --max-old-space-size=512 ./node_modules/.bin/jest \
      --selectProjects integration \
      --testPathPatterns "$file" \
      --colors; then
    FAILED=$((FAILED + 1))
  fi
done

echo ""
if [ "$FAILED" -gt 0 ]; then
  echo "INTEGRATION TESTS FAILED: $FAILED of $(echo "$FILES" | wc -l) files had failures."
  exit 1
fi
echo "All integration test files passed."
