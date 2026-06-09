#!/usr/bin/env bash
# scripts/deploy.sh
#
# Build and (re)start the production stack with Docker Compose, then apply any
# pending Prisma migrations. Run from the repository root on the host that runs
# the containers. Idempotent — safe to re-run.
#
# Prerequisites:
#   - Docker + Docker Compose installed and running
#   - A root `.env` with DATABASE_URL, POSTGRES_*, NEXTAUTH_SECRET,
#     APP_ENCRYPTION_KEY, and any integration keys (see env.example)
#
# Usage:
#   ./scripts/deploy.sh
#
# Optional environment:
#   DB_CONTAINER   Postgres container/service name (default: db)
#   SKIP_BACKUP    set to 1 to skip the pre-deploy DB backup

set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-db}"

echo "=== Pre-deploy database backup ==="
if [ "${SKIP_BACKUP:-0}" != "1" ]; then
  ./scripts/backup-db.sh || echo "WARN: backup failed; continuing (set SKIP_BACKUP=1 to silence)"
else
  echo "Skipped (SKIP_BACKUP=1)."
fi

echo "=== Building and starting containers ==="
docker compose up -d --build

echo "=== Applying pending Prisma migrations ==="
# Run migrations from inside the app container so it uses the bundled Prisma CLI
# and the container's DATABASE_URL.
docker compose exec -T app npx prisma migrate deploy

echo "=== Deploy complete. Verify the app responds at your configured URL (e.g. /api/health). ==="
