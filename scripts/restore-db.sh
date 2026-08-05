#!/bin/bash
# restore-db.sh
#
# Restore the database from a backup: stop the app, drop/recreate the DB,
# restore, restart.
#
# Usage:
#   ./scripts/restore-db.sh backups/db-backup-20260324_120000.sql.gz
#   ./scripts/restore-db.sh --database fbc_prod_db backups/db-backup-....sql.gz
#
# Supports .sql and .sql.gz.
#
# ---------------------------------------------------------------------------
# SAFETY NOTES -- read before editing. This script drops a database.
#
# It used to hardcode CONTAINER="furniture-configurator-db-1" with a fallback
# to "tender-robinson-db-1", then run DROP DATABASE against whichever answered.
# Those are OTHER PROJECTS' containers. On a machine running both, holt's
# restore script would drop a database inside the furniture-configurator stack.
# The container is now resolved from THIS repo's compose project
# (docker compose ps -q db), so it can only ever address holt's own service.
#
# It also validated nothing before dropping, and piped the restore to
# /dev/null 2>&1 -- so a corrupt or truncated dump destroyed the database and
# then printed "Restore complete." The dump is now checked first, the restore's
# exit status and stderr are inspected, and a pre-drop safety dump is taken so
# there is a way back from a restore that fails halfway.
# ---------------------------------------------------------------------------

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DB_NAME_OVERRIDE=""
BACKUP_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --database|-d) DB_NAME_OVERRIDE="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--database <name>] <backup-file>"
      exit 0 ;;
    *) BACKUP_FILE="$1"; shift ;;
  esac
done

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: $0 [--database <name>] <backup-file>" >&2
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo -e "${RED}ERROR: Backup file not found: $BACKUP_FILE${NC}" >&2
  exit 1
fi

DB_USER="${POSTGRES_USER:-dbuser_fbc}"
DB_NAME="${DB_NAME_OVERRIDE:-${POSTGRES_DB:-fbc_prod_db}}"

# --- Resolve the container from THIS project, never by guessing a name -------
CONTAINER="$(docker compose ps -q db 2>/dev/null || true)"
if [ -z "$CONTAINER" ]; then
  echo -e "${RED}ERROR: no running 'db' service in this compose project.${NC}" >&2
  echo "  Run this from the holt repo with the stack up: docker compose up -d db" >&2
  echo "  (This script deliberately will NOT search for a database container by" >&2
  echo "   name -- doing so is how it previously targeted another project.)" >&2
  exit 1
fi

CONTAINER_NAME="$(docker inspect --format '{{.Name}}' "$CONTAINER" | sed 's|^/||')"

if ! docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" > /dev/null 2>&1; then
  echo -e "${RED}ERROR: database '$DB_NAME' not reachable in container $CONTAINER_NAME${NC}" >&2
  exit 1
fi

# --- Validate the dump BEFORE destroying anything ---------------------------
echo -e "${YELLOW}[1/6] Validating backup file...${NC}"

if [[ "$BACKUP_FILE" == *.gz ]]; then
  # Catches the truncated-download case: a partial .gz fails integrity here
  # rather than after the database is already gone.
  if ! gzip -t "$BACKUP_FILE" 2>/dev/null; then
    echo -e "${RED}ERROR: $BACKUP_FILE is not a valid gzip file (truncated or corrupt).${NC}" >&2
    exit 1
  fi
  DUMP_HEAD="$(gunzip -c "$BACKUP_FILE" 2>/dev/null | head -c 4096 || true)"
  DUMP_TAIL="$(gunzip -c "$BACKUP_FILE" 2>/dev/null | tail -c 512 || true)"
else
  DUMP_HEAD="$(head -c 4096 "$BACKUP_FILE")"
  DUMP_TAIL="$(tail -c 512 "$BACKUP_FILE")"
fi

if ! printf '%s' "$DUMP_HEAD" | grep -q "PostgreSQL database dump"; then
  echo -e "${RED}ERROR: $BACKUP_FILE does not look like a pg_dump file.${NC}" >&2
  exit 1
fi

# pg_dump writes this marker as its last line. Its absence means the dump was
# cut short -- the exact failure the admin download endpoint could produce.
if ! printf '%s' "$DUMP_TAIL" | grep -q "PostgreSQL database dump complete"; then
  echo -e "${RED}ERROR: $BACKUP_FILE is missing pg_dump's completion marker.${NC}" >&2
  echo "  The dump is truncated. Restoring it would give you a partial database" >&2
  echo "  that looks fine until the missing rows matter." >&2
  exit 1
fi
echo "  Valid pg_dump, complete."

# --- Confirm, naming the actual target --------------------------------------
echo ""
echo -e "${YELLOW}This will REPLACE the contents of:${NC}"
echo -e "  database:  ${RED}$DB_NAME${NC}"
echo -e "  container: $CONTAINER_NAME"
echo -e "  from:      $BACKUP_FILE"
echo ""
# Typing the database name (not a generic word) is the point: it is the last
# chance to notice the target is not the database you meant.
read -r -p "Type the database name to confirm: " CONFIRM
if [ "$CONFIRM" != "$DB_NAME" ]; then
  echo "Aborted."
  exit 0
fi

# --- Safety dump so a failed restore is recoverable -------------------------
echo -e "${YELLOW}[2/6] Taking a safety dump of the current database...${NC}"
SAFETY_DIR="${BACKUP_DIR:-./backups}/pre-restore"
mkdir -p "$SAFETY_DIR"
SAFETY_FILE="$SAFETY_DIR/${DB_NAME}-before-restore-$(date +%Y%m%d_%H%M%S).sql.gz"
if docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" 2>/dev/null | gzip > "$SAFETY_FILE"; then
  echo "  Wrote $SAFETY_FILE"
else
  rm -f "$SAFETY_FILE"
  echo -e "${YELLOW}  WARNING: safety dump failed (empty or unreachable database).${NC}"
  read -r -p "  Continue WITHOUT a rollback point? Type 'yes': " GO_ON
  [ "$GO_ON" = "yes" ] || { echo "Aborted."; exit 1; }
fi

echo -e "${YELLOW}[3/6] Stopping app container...${NC}"
docker compose stop app 2>/dev/null || docker compose stop app-dev 2>/dev/null || true
echo "  Done"

echo -e "${YELLOW}[4/6] Dropping and recreating '$DB_NAME'...${NC}"
docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c "
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB_NAME' AND pid <> pg_backend_pid();
" > /dev/null 2>&1 || true
docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$DB_NAME\";"
docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c "CREATE DATABASE \"$DB_NAME\" OWNER \"$DB_USER\";"
echo "  Done"

# --- Restore, WITHOUT swallowing errors -------------------------------------
echo -e "${YELLOW}[5/6] Restoring...${NC}"
RESTORE_LOG="$(mktemp)"
set +e
if [[ "$BACKUP_FILE" == *.gz ]]; then
  gunzip -c "$BACKUP_FILE" | docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" > "$RESTORE_LOG" 2>&1
else
  docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$BACKUP_FILE" > "$RESTORE_LOG" 2>&1
fi
RESTORE_STATUS=$?
set -e

if [ "$RESTORE_STATUS" -ne 0 ]; then
  echo -e "${RED}RESTORE FAILED (psql exit $RESTORE_STATUS).${NC}" >&2
  echo "  Last lines:" >&2
  tail -20 "$RESTORE_LOG" >&2
  echo "" >&2
  echo -e "${RED}The database is now EMPTY or PARTIAL. Recover with:${NC}" >&2
  echo "  $0 --database $DB_NAME $SAFETY_FILE" >&2
  rm -f "$RESTORE_LOG"
  exit 1
fi
rm -f "$RESTORE_LOG"
echo "  Done"

# --- Verify, and treat an empty result as failure ---------------------------
echo -e "${YELLOW}[6/6] Verifying...${NC}"
TABLE_COUNT=$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A \
  -c "SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'public'")
echo "  Public tables: $TABLE_COUNT"

if [ "$TABLE_COUNT" -eq 0 ]; then
  echo -e "${RED}ERROR: restore produced ZERO tables.${NC}" >&2
  echo "  psql reported success but nothing landed. Recover with:" >&2
  echo "  $0 --database $DB_NAME $SAFETY_FILE" >&2
  exit 1
fi

docker compose up -d app > /dev/null 2>&1 || true
sleep 3
HEALTH=$(curl -s http://localhost:3000/api/health 2>/dev/null || echo '{"status":"unreachable"}')
echo "  Health: $HEALTH"

echo ""
echo -e "${GREEN}Restore complete.${NC}"
echo "  Rollback point kept at: $SAFETY_FILE"
