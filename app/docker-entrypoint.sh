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

exec su-exec node "$@"
