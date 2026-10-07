#!/usr/bin/env bash
# scripts/backup-uploads.sh
#
# Back up uploaded files (ticket attachments, inventory photos, vendor line
# drawings) to a timestamped tarball and prune old ones. These live in the
# `uploads` Docker volume mounted at /app/data/uploads and are NOT part of the
# SQL dump — a database-only backup loses every file. Run this alongside
# scripts/backup-db.sh.
#
# Configure via environment:
#   UPLOADS_VOLUME   docker volume holding the files (default: holt_uploads)
#   UPLOADS_DIR      OR a host path, for non-Docker deployments (overrides volume)
#   BACKUP_DIR       where tarballs are written (default: ./backups)
#   RETENTION_DAYS   days of backups to keep (default: 14)
#
# Example cron (daily at 02:10, just after the DB backup):
#   10 2 * * * cd /path/to/holt && ./scripts/backup-uploads.sh >> ./backups/backup.log 2>&1

set -euo pipefail

UPLOADS_VOLUME="${UPLOADS_VOLUME:-holt_uploads}"
UPLOADS_DIR="${UPLOADS_DIR:-}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/uploads-backup-$TIMESTAMP.tgz"
# Resolve BACKUP_DIR to an absolute path so the docker mount works regardless of cwd.
ABS_BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"

if [ -n "$UPLOADS_DIR" ]; then
  echo "Backing up uploads from host path '$UPLOADS_DIR'..."
  if [ ! -d "$UPLOADS_DIR" ]; then
    echo "ERROR: UPLOADS_DIR '$UPLOADS_DIR' does not exist" >&2
    exit 1
  fi
  tar czf "$BACKUP_FILE" -C "$UPLOADS_DIR" .
else
  echo "Backing up uploads from docker volume '$UPLOADS_VOLUME'..."
  # A throwaway alpine container mounts the volume read-only and the backup dir
  # read-write, then tars the volume contents into it. No app container needed.
  docker run --rm \
    -v "$UPLOADS_VOLUME":/from:ro \
    -v "$ABS_BACKUP_DIR":/to \
    alpine tar czf "/to/uploads-backup-$TIMESTAMP.tgz" -C /from .
fi

echo "Wrote $BACKUP_FILE"

DELETED=$(find "$BACKUP_DIR" -name "uploads-backup-*.tgz" -mtime +"$RETENTION_DAYS" -print -delete | wc -l | tr -d ' ')
echo "Pruned $DELETED uploads backup(s) older than $RETENTION_DAYS days."
