#!/bin/sh
# app/docker-entrypoint.sh
#
# Runs as root to fix ownership on Docker-mounted volumes, then drops
# to the node user (uid 1000) to start the application.

set -e

# Ensure the uploads directory tree exists and is writable by node.
# Uploads live in /data/uploads (not /public/uploads) so Next.js does not
# scandir the Docker volume on startup. On Synology with user namespace
# remapping, chown may not take effect, so chmod is applied as a fallback.
mkdir -p /app/data/uploads/inventory /app/data/uploads/line-drawings
chown -R node:node /app/data 2>/dev/null || true
chmod -R 755 /app/data

# Apply migrations before the app accepts traffic.
#
# This used to live only in scripts/deploy.sh, so `docker compose up` started a
# container against an unmigrated database -- it booted, then failed on the
# first query, and the cause was several layers from the symptom. Doing it here
# means every way of starting the container migrates, not just the one blessed
# path.
#
# RUN_MIGRATIONS=false opts out for a container that must not touch the schema
# (a read replica, or a second instance racing the first during a rollout).
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "entrypoint: applying migrations..."
  if ! su-exec node npx prisma migrate deploy; then
    echo "entrypoint: migrations FAILED -- refusing to start against an unmigrated database" >&2
    exit 1
  fi
fi

exec su-exec node "$@"
