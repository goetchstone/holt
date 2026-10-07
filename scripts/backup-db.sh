#!/usr/bin/env bash
# scripts/backup-db.sh
#
# Dump the application Postgres database to a timestamped, gzipped SQL file,
# verify the dump is complete, optionally copy it off this host, and prune
# backups older than the retention window.
#
# Configure via environment:
#   DB_CONTAINER     override container/id for Postgres. Default: resolved from
#                    this repo's compose project (docker compose ps -q db).
#   POSTGRES_USER    database user           (default: dbuser_fbc)
#   POSTGRES_DB      database name           (default: fbc_prod_db)
#   BACKUP_DIR       where dumps are written (default: ./backups)
#   RETENTION_DAYS   days of local backups to keep (default: 14)
#   BACKUP_REMOTE    off-host destination, e.g. user@nas:/volume1/holt-backups
#                    or an rclone remote like s3:holt-backups. STRONGLY
#                    RECOMMENDED -- see "Off-host" below.
#   BACKUP_REMOTE_CMD  "rsync" (default) or "rclone".
#
# Example cron (daily at 02:00) -- or just run scripts/install-cron.sh, which
# now installs this for you:
#   0 2 * * * cd /path/to/holt && ./scripts/backup-db.sh >> ./backups/backup.log 2>&1
#
# ---------------------------------------------------------------------------
# Two things this script previously got wrong, both silent:
#
# 1. DB_CONTAINER defaulted to the literal string "db". Compose names the
#    container <project>-db-1, so `docker exec db` fails with "No such
#    container" -- the script did not work with its own documented defaults.
#    It now resolves the container from the compose project, like
#    restore-db.sh does.
#
# 2. It never checked that the dump was COMPLETE. pg_dump can exit non-zero
#    mid-stream, or the disk can fill, leaving a valid-looking .gz holding half
#    a database. You find out at restore time, which is the worst possible
#    moment. The completion marker is now verified before the file counts as a
#    backup at all.
#
# Off-host: a backup sitting on the same disk as the database is not a backup;
# it is a second copy of a single point of failure. If BACKUP_REMOTE is set the
# copy is mandatory -- a failure to send is a FAILED backup and exits non-zero,
# because a silently local-only backup is exactly the state you think you are
# protected from.
# ---------------------------------------------------------------------------

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DB_USER="${POSTGRES_USER:-dbuser_fbc}"
DB_NAME="${POSTGRES_DB:-fbc_prod_db}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
BACKUP_REMOTE="${BACKUP_REMOTE:-}"
BACKUP_REMOTE_CMD="${BACKUP_REMOTE_CMD:-rsync}"

# Resolve the container from THIS compose project unless explicitly overridden.
DB_CONTAINER="${DB_CONTAINER:-$(docker compose ps -q db 2>/dev/null || true)}"
if [ -z "$DB_CONTAINER" ]; then
  echo "ERROR: no running 'db' service in this compose project." >&2
  echo "  Start it (docker compose up -d db), or set DB_CONTAINER explicitly." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/db-backup-$TIMESTAMP.sql.gz"

echo "Backing up database '$DB_NAME'..."
# pipefail makes a pg_dump failure fail the pipeline rather than leaving a
# truncated .gz that looks like a successful backup.
if ! docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$BACKUP_FILE"; then
  rm -f "$BACKUP_FILE"
  echo "ERROR: pg_dump failed; removed the partial file." >&2
  exit 1
fi

# --- Verify before it counts as a backup ------------------------------------
if ! gzip -t "$BACKUP_FILE" 2>/dev/null; then
  rm -f "$BACKUP_FILE"
  echo "ERROR: dump is not valid gzip; removed it." >&2
  exit 1
fi

if ! gunzip -c "$BACKUP_FILE" | tail -c 512 | grep -q "PostgreSQL database dump complete"; then
  rm -f "$BACKUP_FILE"
  echo "ERROR: dump is missing pg_dump's completion marker (truncated); removed it." >&2
  echo "  Check free disk space on the backup volume." >&2
  exit 1
fi

SIZE="$(du -h "$BACKUP_FILE" | cut -f1)"
echo "Wrote $BACKUP_FILE ($SIZE), verified complete."

# --- Off-host copy ----------------------------------------------------------
if [ -n "$BACKUP_REMOTE" ]; then
  echo "Copying to off-host destination: $BACKUP_REMOTE"
  case "$BACKUP_REMOTE_CMD" in
    rsync)
      if ! rsync -a --partial "$BACKUP_FILE" "$BACKUP_REMOTE/"; then
        echo "ERROR: off-host copy FAILED. This backup exists only on this host." >&2
        exit 1
      fi ;;
    rclone)
      if ! rclone copy "$BACKUP_FILE" "$BACKUP_REMOTE"; then
        echo "ERROR: off-host copy FAILED. This backup exists only on this host." >&2
        exit 1
      fi ;;
    *)
      echo "ERROR: BACKUP_REMOTE_CMD must be 'rsync' or 'rclone', got '$BACKUP_REMOTE_CMD'." >&2
      exit 1 ;;
  esac
  echo "Off-host copy complete."
else
  # Loud on purpose. A cron log full of this line is the intended nag.
  echo "WARNING: BACKUP_REMOTE is not set -- this backup exists only on this host." >&2
  echo "  A dump on the same disk as the database does not survive that disk." >&2
fi

# Prune only AFTER a verified backup, so a run of failures cannot age out the
# last good copy.
DELETED=$(find "$BACKUP_DIR" -maxdepth 1 -name "db-backup-*.sql.gz" -mtime +"$RETENTION_DAYS" -print -delete | wc -l | tr -d ' ')
echo "Pruned $DELETED local backup(s) older than $RETENTION_DAYS days."
