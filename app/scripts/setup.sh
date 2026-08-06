#!/usr/bin/env bash
# app/scripts/setup.sh  --  `npm run setup`
#
# Empty database -> a system you can log into with real data in it, in one
# command.
#
# This exists because there wasn't one. The pieces were all present and good
# (migrations, a 37-model demo seed with ~18 months of orders and real journal
# entries, a CMS seed) but reaching them meant: read one domain doc to learn
# `seed:demo` exists, notice env.example ships a database name the seed
# refuses, discover prisma.config.ts reads a file nothing creates, and export
# DATABASE_URL by hand. A newcomer hit a wall at every one of those.
#
# Idempotent: safe to re-run. Migrations skip what's applied and the seed
# upserts.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
step() { echo -e "${YELLOW}==> $1${NC}"; }
fail() { echo -e "${RED}$1${NC}" >&2; exit 1; }

SCALE="${SCALE:-demo}"
SKIP_CMS=0
for arg in "$@"; do
  case "$arg" in
    --scale=*) SCALE="${arg#*=}" ;;
    --no-cms)  SKIP_CMS=1 ;;
    -h|--help)
      echo "Usage: npm run setup [-- --scale=ci|demo] [--no-cms]"
      echo "  --scale=demo  ~18 months of data (default, ~40s)"
      echo "  --scale=ci    minimal fixture set (~4s)"
      exit 0 ;;
  esac
done

# --- Env -------------------------------------------------------------------
# Same precedence prisma.config.ts uses, so the CLI and this script can never
# disagree about which database they mean.
if [ -z "${DATABASE_URL:-}" ] && [ -f ".env.local" ]; then
  DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env.local | sed 's/^DATABASE_URL=//; s/^"//; s/"$//' || true)"
fi
if [ -z "${DATABASE_URL:-}" ] && [ -f "../.env" ]; then
  DATABASE_URL="$(grep -m1 '^DATABASE_URL=' ../.env | sed 's/^DATABASE_URL=//; s/^"//; s/"$//' || true)"
fi
export DATABASE_URL

if [ -z "${DATABASE_URL:-}" ]; then
  fail "DATABASE_URL is not set.
  Copy env.example to .env and app/.env.local.example to app/.env.local,
  then start Postgres:  docker compose up db -d"
fi

DB_NAME="${DATABASE_URL##*/}"; DB_NAME="${DB_NAME%%\?*}"
echo "    database: $DB_NAME"

# The seed refuses a handful of names outright (they hold real or shared data).
# Better to say so here than to let the seed exit 1 after the migrate step.
case "$DB_NAME" in
  fbc_test_db|fbc_dev_db|saybrook|holt_saybrook|akritos)
    fail "Refusing to set up '$DB_NAME' -- it is a shared or restored database.
  Point DATABASE_URL at a fresh database name (env.example uses holt_dev)." ;;
esac

# --- Reachability ----------------------------------------------------------
step "Checking the database is reachable"
if ! npx --yes prisma db execute --stdin <<<"SELECT 1;" >/dev/null 2>&1; then
  fail "Cannot reach Postgres at that URL.
  Start it with:  docker compose up db -d
  If it is running, check the host/port -- inside compose the host is 'db',
  from your machine it is localhost on the mapped port."
fi

step "Applying migrations"
npx prisma migrate deploy

step "Generating the Prisma client"
npx prisma generate >/dev/null

# The migration that created Role/RolePermission already inserted the eight
# built-in roles, and `npm run dev` reconciles them again on boot via
# src/instrumentation.ts. Running it explicitly here means a fresh checkout has
# correct roles BEFORE the demo seed creates staff, rather than one server boot
# later, and it puts the step somewhere a developer can see it.
step "Seeding built-in roles"
npm run seed:roles

step "Seeding demo data (scale=$SCALE)"
npm run seed:demo -- --scale="$SCALE"

if [ "$SKIP_CMS" -eq 0 ]; then
  step "Seeding CMS content"
  npm run seed:cms
fi

# --- What now --------------------------------------------------------------
echo ""
echo -e "${GREEN}Setup complete.${NC}"
echo ""
echo "  Start it:   npm run dev          (from app/)"
echo "  Then open:  http://localhost:3000/auth/login"
echo ""
echo "  Sign in with any seeded staff account, e.g."
echo "    admin@example.com  /  Showroom2026!"
echo ""
echo "  Local password login needs AUTH_LOCAL_ENABLED=true in app/.env.local."
echo "  Verify the whole thing with:  bash scripts/smoke.sh"
