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
#
# Only when something is wrong. The volume is shared by every app process, and
# walking all of it (chown -R, chmod -R) on every process's every start made
# start-up time grow with the number of uploaded files, times the number of
# processes. Files the app writes are already node's, so the directories
# checked here -- the volume's root and the ones created just above -- say
# whether a fix is needed: a fresh volume (root's) or one restored from
# elsewhere gets the full walk once; after that, a start does four stats.
mkdir -p /app/data/uploads/inventory /app/data/uploads/line-drawings
needs_fix=0
for d in /app/data /app/data/uploads /app/data/uploads/inventory /app/data/uploads/line-drawings; do
  [ "$(stat -c %U "$d" 2>/dev/null)" = "node" ] || needs_fix=1
done
if [ "$needs_fix" = "1" ]; then
  echo "entrypoint: fixing ownership of /app/data..."
  chown -R node:node /app/data 2>/dev/null || true
  chmod -R 755 /app/data
fi

# Apply migrations before the app accepts traffic.
#
# This used to live only in scripts/deploy.sh, so `docker compose up` started a
# container against an unmigrated database -- it booted, then failed on the
# first query, and the cause was several layers from the symptom. Doing it here
# means every way of starting the container migrates, not just the one blessed
# path.
#
# RUN_MIGRATIONS=false opts out for a container that must not touch the schema.
# docker-compose.yml's `app` service sets it: its processes may number several,
# and they would race for Prisma's migration lock, so the one-shot `migrate`
# service migrates once before any of them starts. The other services that
# run this image alone (staging, the practice copy, scripts/dev-app-up.sh) keep
# the default and migrate here.
#
# The built-in roles are deliberately NOT seeded by a step here. They are
# covered twice over, and neither way needs a script this image does not have
# (stage 3 ships no src/ and no scripts/, so a ts-node seeder could not run):
# the migration that creates Role/RolePermission inserts the eight roles
# itself, and src/instrumentation.ts reconciles them against
# lib/auth/permissionCatalog.ts when the server boots -- that is the `exec`
# below, strictly after this migrate step. → docs/domains/staff-auth.md
#
# The Prisma CLI is the one the app installed, called by path: the runner stage
# deletes npm and npx (see the Dockerfile), so `npx prisma` would not be found.
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "entrypoint: applying migrations..."
  if ! su-exec node node_modules/.bin/prisma migrate deploy; then
    echo "entrypoint: migrations FAILED -- refusing to start against an unmigrated database" >&2
    exit 1
  fi
fi

exec su-exec node "$@"
