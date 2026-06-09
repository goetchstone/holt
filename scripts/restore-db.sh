#!/bin/bash
# restore-db.sh
#
# Restores the production database from a backup file.
# Stops the app, drops/recreates the DB, restores, and restarts.
#
# Usage:
#   ./scripts/restore-db.sh backups/fbc_prod_db_20260324_120000.sql.gz
#
# Supports both .sql and .sql.gz files.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <backup-file>" >&2
  echo "  Supports .sql and .sql.gz files" >&2
  exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: Backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

DB_USER="${POSTGRES_USER:-dbuser_fbc}"
DB_NAME="${POSTGRES_DB:-fbc_prod_db}"
CONTAINER="furniture-configurator-db-1"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Find the running database container
if ! docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" > /dev/null 2>&1; then
  CONTAINER="tender-robinson-db-1"
  if ! docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" > /dev/null 2>&1; then
    echo -e "${RED}ERROR: Database container not reachable${NC}" >&2
    exit 1
  fi
fi

echo -e "${YELLOW}WARNING: This will REPLACE the contents of database '$DB_NAME'.${NC}"
echo -e "Backup file: $BACKUP_FILE"
read -p "Type 'RESTORE' to confirm: " CONFIRM
if [ "$CONFIRM" != "RESTORE" ]; then
  echo "Aborted."
  exit 0
fi

# Step 1: Stop the app container
echo -e "${YELLOW}[1/4] Stopping app container...${NC}"
docker compose stop app 2>/dev/null || docker compose stop app-dev 2>/dev/null || true
echo "  Done"

# Step 2: Drop and recreate the database
echo -e "${YELLOW}[2/4] Dropping and recreating database...${NC}"
docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c "
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB_NAME' AND pid <> pg_backend_pid();
" > /dev/null 2>&1 || true
docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$DB_NAME\";"
docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c "CREATE DATABASE \"$DB_NAME\" OWNER \"$DB_USER\";"
echo "  Done"

# Step 3: Restore from backup
echo -e "${YELLOW}[3/4] Restoring from backup...${NC}"
if [[ "$BACKUP_FILE" == *.gz ]]; then
  gunzip -c "$BACKUP_FILE" | docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" > /dev/null 2>&1
else
  docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" < "$BACKUP_FILE" > /dev/null 2>&1
fi
echo "  Done"

# Step 4: Restart the app
echo -e "${YELLOW}[4/4] Restarting app...${NC}"
docker compose up -d app
echo "  Done"

# Verify
echo ""
echo -e "${YELLOW}Verifying...${NC}"
sleep 3
TABLE_COUNT=$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'public'" | tr -d ' ')
echo "  Public tables: $TABLE_COUNT"

HEALTH=$(curl -s http://localhost:3000/api/health 2>/dev/null || echo '{"status":"unreachable"}')
echo "  Health: $HEALTH"

echo ""
echo -e "${GREEN}Restore complete.${NC}"
