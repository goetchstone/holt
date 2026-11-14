#!/usr/bin/env bash
# scripts/dev-app-up.sh
#
# Bring the local "prod" app container up against the dev DB -- CORRECTLY.
#
# Why this exists: the app runs in a container, but the dev Postgres is published
# on the HOST at :5435. Inside the container, `localhost` is the container, not
# the host -- so the DATABASE_URL in .env / app/.env.local (which targets
# localhost:5435 for host-side tools like the seed) MUST be rewritten to
# host.docker.internal:5435 for the container. Skip the swap and every query is
# ECONNREFUSED -> the app serves 500s on a reachable-but-blank page.
#
# This was already a documented gotcha (docs/DEPLOYMENTS.md) that still got
# hand-skipped once, serving 500s. This script makes the swap impossible to
# forget. ALWAYS bring the app up with this, never raw `docker compose up app`.
# See .claude/skills/post-failure/SKILL.md (2026-06-05 entry).
#
# Usage:
#   scripts/dev-app-up.sh            # recreate the app container (no rebuild)
#   scripts/dev-app-up.sh --build    # rebuild the image first, then recreate
set -euo pipefail

cd "$(dirname "$0")/.." # repo root

NAME=holt-app-local

BUILD=0
case "${1:-}" in
  --build | -b) BUILD=1 ;;
  "") BUILD=0 ;;
  *)
    echo "Unknown arg: $1 (use --build or nothing)" >&2
    exit 2
    ;;
esac

# Source DATABASE_URL from .env (fallback app/.env.local). Keep everything after
# the first '=' so a password containing '=' survives.
DBURL_HOST=""
for f in .env app/.env.local; do
  if [ -f "$f" ]; then
    line=$(grep -E '^DATABASE_URL=' "$f" | head -1 || true)
    if [ -n "$line" ]; then
      DBURL_HOST="${line#DATABASE_URL=}"
      break
    fi
  fi
done
if [ -z "$DBURL_HOST" ]; then
  echo "ERROR: DATABASE_URL not found in .env or app/.env.local" >&2
  exit 1
fi

# The one transformation the container needs.
DBURL_CONTAINER=$(printf '%s' "$DBURL_HOST" | sed 's#@localhost:#@host.docker.internal:#')

if [ "$BUILD" = "1" ]; then
  echo "Building app image..."
  DOCKER_BUILDKIT=1 docker compose build app
fi

# The compose `app` service publishes no host port (it may run as several
# processes behind nginx; docker-compose.yml), so this runs ONE process from the
# same image and service config with the port published on this machine's
# loopback, under a fixed name so a re-run replaces it. RUN_MIGRATIONS=true:
# there is no `migrate` service run here, so the entrypoint migrates, as a single
# process safely can.
echo "Recreating app container $NAME (DB host -> host.docker.internal)..."
docker rm -f "$NAME" >/dev/null 2>&1 || true
DATABASE_URL="$DBURL_CONTAINER" docker compose run -d --no-deps --name "$NAME" \
  --publish 127.0.0.1:3000:3000 -e RUN_MIGRATIONS=true app >/dev/null

# Keep Docker's disk from filling -- a full build cache crashed the dev DB once.
docker builder prune -af >/dev/null 2>&1 || true

echo -n "Waiting for http://localhost:3000/ "
code=000
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/ || true)
  [ "$code" = "200" ] && break
  echo -n "."
  sleep 2
done
echo
if [ "$code" = "200" ]; then
  echo "OK -- app is up and serving 200."
else
  echo "WARN -- app not serving 200 (last=$code). Check: docker logs $NAME --tail 40" >&2
  exit 1
fi
