#!/usr/bin/env bash
# app/scripts/smoke.sh
#
# Proves a deployment actually WORKS, not just that it compiles.
#
# CI ran validate, typecheck and 2,985 unit tests and never once started the
# app. A change that broke startup -- a missing env var, a bad migration, a
# module that throws on import -- passed green. This is the gate that catches
# that class of failure, and it is deliberately end-to-end: boot, health,
# authenticate as a real seeded user, then load a page that requires both a
# session and data.
#
# Usage:
#   bash scripts/smoke.sh                  # against an already-running app
#   BASE_URL=http://localhost:3000 bash scripts/smoke.sh
#   START=1 bash scripts/smoke.sh          # start `npm run dev`, test, stop
#
# Exits non-zero on the first failure, and says what to do about it.

set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

BASE_URL="${BASE_URL:-http://localhost:3000}"
EMAIL="${SMOKE_EMAIL:-admin@example.com}"
PASSWORD="${SMOKE_PASSWORD:-Showroom2026!}"
START="${START:-0}"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-120}"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
COOKIES="$(mktemp)"; LOGDIR="$(mktemp -d)"; DEV_PID=""
pass() { echo -e "  ${GREEN}ok${NC}   $1"; }
fail() { echo -e "  ${RED}FAIL${NC} $1" >&2; [ -n "${2:-}" ] && echo -e "       ${2}" >&2; cleanup; exit 1; }

cleanup() {
  if [ -n "$DEV_PID" ] && kill -0 "$DEV_PID" 2>/dev/null; then
    kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
  rm -f "$COOKIES"
}
trap cleanup EXIT

echo "Smoke test against $BASE_URL"

# --- 0. Optionally start the app -------------------------------------------
if [ "$START" = "1" ]; then
  echo "  starting npm run dev ..."
  npm run dev > "$LOGDIR/dev.log" 2>&1 &
  DEV_PID=$!
  for _ in $(seq 1 "$BOOT_TIMEOUT"); do
    curl -sf -o /dev/null "$BASE_URL/api/health" && break
    if ! kill -0 "$DEV_PID" 2>/dev/null; then
      fail "the app exited during startup" "$(tail -20 "$LOGDIR/dev.log")"
    fi
    sleep 1
  done
fi

# --- 1. Reachable ----------------------------------------------------------
if ! curl -sf -o /dev/null --max-time 10 "$BASE_URL/api/health"; then
  fail "app is not answering at $BASE_URL" \
       "Start it with:  npm run dev     (or re-run with START=1)"
fi
pass "app is up"

# --- 2. Ready ---------------------------------------------------------------
# ?ready=1 503s when the org's AppSettings row is missing, i.e. migrated but
# never seeded -- the state that looks fine until every page is empty.
READY="$(curl -s --max-time 15 "$BASE_URL/api/health?ready=1")"
if ! grep -q '"status":"ok"' <<<"$READY"; then
  fail "readiness check failed" \
       "$READY
       If this says the settings row is missing, run:  npm run setup"
fi
pass "database reachable and seeded"

# --- 3. Authenticate as a real seeded user ---------------------------------
# The full NextAuth credentials handshake, because "the login page renders" is
# not the same claim as "a person can get in". Needs AUTH_LOCAL_ENABLED=true;
# without it the provider is not registered and this is exactly where a fresh
# clone breaks.
CSRF="$(curl -s -c "$COOKIES" "$BASE_URL/api/auth/csrf" | sed -n 's/.*"csrfToken":"\([^"]*\)".*/\1/p')"
[ -n "$CSRF" ] || fail "could not fetch a CSRF token" "Is NEXTAUTH_SECRET set in app/.env.local?"

curl -s -o /dev/null -b "$COOKIES" -c "$COOKIES" \
  -d "csrfToken=$CSRF" -d "email=$EMAIL" -d "password=$PASSWORD" -d "json=true" \
  "$BASE_URL/api/auth/callback/credentials" --max-time 20

SESSION="$(curl -s -b "$COOKIES" "$BASE_URL/api/auth/session")"
if ! grep -q '"user"' <<<"$SESSION"; then
  fail "could not sign in as $EMAIL" \
       "Set AUTH_LOCAL_ENABLED=true in app/.env.local (the seeded passwords are
       unusable without it), and confirm the demo seed has run."
fi
pass "signed in as $EMAIL"

# --- 4. A page that needs BOTH a session and data --------------------------
# Authenticated + populated is the property. A 200 on a public page would
# prove neither.
ORDERS="$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" --max-time 30 "$BASE_URL/app/sales/orders")"
[ "$ORDERS" = "200" ] || fail "/app/sales/orders returned $ORDERS (expected 200)"
pass "authenticated page loads"

# Hit an API that reads seeded rows, so an empty database fails here rather
# than rendering a convincing but empty screen.
COUNT="$(curl -s -b "$COOKIES" --max-time 30 "$BASE_URL/api/sales/orders?limit=1" \
  | grep -o '"id"' | head -1 | wc -l | tr -d ' ')"
[ "$COUNT" = "1" ] || fail "no sales orders returned -- database is migrated but not seeded" \
       "Run:  npm run setup"
pass "seeded data is readable"

echo -e "${GREEN}Smoke test passed.${NC}"
