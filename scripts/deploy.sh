#!/usr/bin/env bash
# scripts/deploy.sh
#
# Build and (re)start the production stack with Docker Compose. Run from the
# repository root on the host that runs the containers. Idempotent.
#
# Ordering matters (fixes the old build-then-migrate race): we build the new
# image and apply migrations with it WHILE THE OLD APP IS STILL SERVING, then
# swap the app/nginx to the new image, then health-gate. For purely additive
# migrations (the common case) this is zero-error. DESTRUCTIVE migrations
# (drop/rename a column the running code still reads) need a two-phase deploy
# — see docs/PRODUCTION.md "Migrations".
#
# Prerequisites:
#   - Docker + Docker Compose installed and running
#   - A root `.env` with DATABASE_URL, POSTGRES_*, NEXTAUTH_SECRET,
#     APP_ENCRYPTION_KEY, NEXTAUTH_URL, and integration keys (see env.example)
#
# Usage:   ./scripts/deploy.sh
# Env:     SKIP_BACKUP=1   skip the pre-deploy DB backup (not recommended)

set -euo pipefail

echo "=== [1/5] Pre-deploy database backup ==="
if [ "${SKIP_BACKUP:-0}" != "1" ]; then
  ./scripts/backup-db.sh
else
  echo "Skipped (SKIP_BACKUP=1)."
fi

echo "=== [2/5] Building new app image (old container keeps serving) ==="
DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-0}" docker compose build app

echo "=== [3/5] Ensuring database is up ==="
docker compose up -d db

echo "=== [4/5] Applying migrations with the NEW image, before the swap ==="
# A one-off container from the freshly built image runs migrate deploy against
# the live DB while the current app container still answers traffic. If this
# fails the script aborts (set -e) BEFORE the new code goes live — the old
# container is untouched, so you're still up. Roll forward by fixing the
# migration and re-running; the backup from step 1 is the floor.
docker compose run --rm --no-deps app npx prisma migrate deploy

echo "=== [5/5] Switching app + proxy to the new image ==="
docker compose up -d

echo "=== Health gate ==="
url="http://localhost:3000/api/health?ready=1"
code=000
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)
  [ "$code" = "200" ] && break
  sleep 2
done
if [ "$code" = "200" ]; then
  echo "OK — app is healthy and ready (200 from /api/health?ready=1)."
else
  echo "DEPLOY WARNING — app not ready (last=$code). Check: docker compose logs app --tail 60" >&2
  echo "Roll back: re-deploy the previous image tag, or restore the step-1 backup if a migration is at fault." >&2
  exit 1
fi
