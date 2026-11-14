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

# An nginx/nginx.conf from before app processes could be several: it has no
# include of nginx/app-upstream.conf, so the public site would keep sending to
# app addresses it looked up once at start. PRODUCTION.md has operators put
# their domain into this tracked file, so an upgrade that kept their own copy
# lands here. Refuse before anything changes.
if ! grep -q 'include /etc/nginx/app-upstream.conf;' nginx/nginx.conf; then
  echo "ERROR: nginx/nginx.conf is older than this version of Holt." >&2
  echo "  Take the new file and put your domain back into it (docs/DEPLOYMENTS.md, 'nginx.conf'):" >&2
  echo "    git checkout -- nginx/nginx.conf" >&2
  echo "    sed -i 's/REPLACE_ME_DOMAIN/<your domain>/g' nginx/nginx.conf" >&2
  exit 1
fi
if grep -q 'REPLACE_ME_DOMAIN' nginx/nginx.conf; then
  echo "ERROR: nginx/nginx.conf still contains REPLACE_ME_DOMAIN; put your domain into it first:" >&2
  echo "    sed -i 's/REPLACE_ME_DOMAIN/<your domain>/g' nginx/nginx.conf" >&2
  exit 1
fi

echo "=== [1/5] Pre-deploy database backup ==="
if [ "${SKIP_BACKUP:-0}" != "1" ]; then
  ./scripts/backup-db.sh
else
  echo "Skipped (SKIP_BACKUP=1)."
fi

echo "=== [2/5] Building new app image (old containers keep serving) ==="
# Both services that run the image: `migrate` must never run a stale build.
DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-0}" docker compose build migrate app

echo "=== [3/5] Ensuring database is up ==="
docker compose up -d db

echo "=== [4/5] Applying migrations with the NEW image, before the swap ==="
# The compose `migrate` service, from the freshly built image, runs migrate
# deploy against the live DB while the current app processes still answer
# traffic. If this fails the script aborts (set -e) BEFORE the new code goes
# live — the old processes are untouched, so you're still up. Roll forward by
# fixing the migration and re-running; the backup from step 1 is the floor.
docker compose run --rm --no-deps migrate

echo "=== [5/5] Switching app + proxy to the new image ==="
# --no-deps: the database is up (step 3) and migrated (step 4), so `migrate`
# is not run a second time. The app comes up as APP_REPLICAS processes
# (docker-compose.yml `scale`); both nginx servers find them by name within 10s.
docker compose up -d --no-deps app nginx nginx-host

echo "=== Health gate ==="
# Two checks. Every app process answers ready from inside its own container --
# through nginx alone, round robin could pass on one healthy process while
# another fails. Then the path the host's jobs use (nginx-host on the loopback,
# scripts/_cron-run.sh) answers too.
ready_js="fetch('http://localhost:3000/api/health?ready=1').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
url="${APP_BASE_URL:-http://127.0.0.1:8080}/api/health?ready=1"
ok=0
for _ in $(seq 1 45); do
  ids=$(docker compose ps -q app)
  all_ready=1
  [ -n "$ids" ] || all_ready=0
  for id in $ids; do
    docker exec "$id" node -e "$ready_js" >/dev/null 2>&1 || { all_ready=0; break; }
  done
  code=$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)
  if [ "$all_ready" = "1" ] && [ "$code" = "200" ]; then ok=1; break; fi
  sleep 2
done
if [ "$ok" = "1" ]; then
  echo "OK — $(printf '%s\n' "$ids" | wc -l | tr -d ' ') app process(es) ready, and $url answers 200."
else
  echo "DEPLOY WARNING — not every app process is ready (nginx path last=$code)." >&2
  echo "Check: docker compose ps app; docker compose logs app --tail 60" >&2
  echo "Roll back: re-deploy the previous image tag, or restore the step-1 backup if a migration is at fault." >&2
  exit 1
fi
