#!/usr/bin/env bash
# scripts/backup-db.sh
#
# Dump the application Postgres database to a timestamped, gzipped SQL file
# and prune backups older than the retention window. Runs against the
# Dockerized `db` service from docker-compose. Configure via environment:
#
#   DB_CONTAINER     docker container/service name for Postgres (default: db)
#   POSTGRES_USER    database user        (default: $POSTGRES_USER or "app")
#   POSTGRES_DB      database name        (default: $POSTGRES_DB or "app")
#   BACKUP_DIR       where dumps are written (default: ./backups)
#   RETENTION_DAYS   days of backups to keep (default: 14)
#
# Example cron (daily at 02:00):
#   0 2 * * * cd /path/to/app && ./scripts/backup-db.sh >> ./backups/backup.log 2>&1

set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-db}"
DB_USER="${POSTGRES_USER:-app}"
DB_NAME="${POSTGRES_DB:-app}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/db-backup-$TIMESTAMP.sql.gz"

echo "Backing up database '$DB_NAME' from container '$DB_CONTAINER'..."
docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$BACKUP_FILE"
echo "Wrote $BACKUP_FILE"

DELETED=$(find "$BACKUP_DIR" -name "db-backup-*.sql.gz" -mtime +"$RETENTION_DAYS" -print -delete | wc -l | tr -d ' ')
echo "Pruned $DELETED backup(s) older than $RETENTION_DAYS days."
