#!/usr/bin/env bash
# scripts/restore-drill.sh
#
# Prove a backup ACTUALLY restores, instead of trusting that it does. This is
# the docs/PRODUCTION.md "backups scheduled + one restore drilled" go-live
# gate (see also docs/DISASTER-RECOVERY.md "Restore drill (go-live gate)") --
# the checklist item most likely to get skipped under deploy-day pressure,
# and the most catastrophic one to be wrong about, since you only find out a
# backup doesn't restore when you actually need it to.
#
# Restores a backup into a THROWAWAY database on the same Postgres instance,
# verifies real data landed, then drops the throwaway. NEVER touches a real
# database -- see the hard guard below. This script only ever runs read-only
# `pg_dump`-equivalent operations against the source DB (if it takes a fresh
# backup) and CREATE/DROP DATABASE against its own generated scratch name.
#
# Usage:
#   ./scripts/restore-drill.sh [backup-file]
#     backup-file   Path to an existing db-backup-*.sql(.gz). If omitted,
#                   runs scripts/backup-db.sh first and drills the backup it
#                   just produced -- that proves TODAY's backup mechanism
#                   works, not that some old file happens to be readable.
#
# Env (same names/defaults as scripts/backup-db.sh, for one config surface):
#   DB_CONTAINER     docker container running Postgres   (default: db)
#   POSTGRES_USER    database role                       (default: app)
#   POSTGRES_DB      SOURCE database name, only used when taking a fresh
#                    backup                               (default: app)
#   BACKUP_DIR       where dumps live                     (default: ./backups)
#   DRILL_DB_NAME    throwaway database name (default: holt_restore_drill_<ts>)
#                    MUST start with "holt_restore_drill" -- see the guard.
#
# On a clean PASS, records the drill in backups/.last-restore-drill (one
# line: ISO timestamp + backup filename) so scripts/go-live-check.sh can
# verify a drill actually happened recently, not just that backups exist.
#
# Exit: 0 only if the restore verified clean (so this can gate a checklist
# run or a deploy). Non-zero on any failure, including missing tooling --
# a restore drill that couldn't run is not a passed restore drill.

set -euo pipefail

REPO_ROOT=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

DB_CONTAINER="${DB_CONTAINER:-db}"
DB_USER="${POSTGRES_USER:-app}"
SOURCE_DB_NAME="${POSTGRES_DB:-app}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
DRILL_MARKER="$BACKUP_DIR/.last-restore-drill"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"
DRILL_DB_NAME="${DRILL_DB_NAME:-holt_restore_drill_$TIMESTAMP}"

# --- Report state, initialized up front so the cleanup/summary functions ---
# (registered as an EXIT trap before any risky command runs) are always
# safe to call no matter how early or late the script exits, and so
# `set -u` never trips on a not-yet-assigned variable inside them.
BACKUP_FILE="${1:-}"
DB_CREATED=0
RESTORE_OK=0
VERIFY_OK=0
MIGRATIONS_PRESENT=0
TABLE_COUNT=""
MIGRATIONS_COUNT=""
STAFF_COUNT=""
SETTINGS_COUNT=""
RESULT="FAIL"

psql_scalar() {
  # $1 = SQL against the throwaway DB. Prints the first scalar, or nothing +
  # a non-zero return on error (e.g. table doesn't exist). Never trips
  # `set -e` on its own -- callers use it as an `if`/assignment condition.
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DRILL_DB_NAME" -t -A -c "$1" 2>/dev/null
}

print_summary() {
  echo
  echo "=== Restore Drill Summary (paste into your go-live checklist) ==="
  echo "Date:                $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Backup file:         ${BACKUP_FILE:-<none resolved>}"
  echo "Throwaway DB:        $DRILL_DB_NAME (dropped: $([ "$DB_CREATED" = 1 ] && echo yes || echo "never created"))"
  echo "Restore command:     $([ "$RESTORE_OK" = 1 ] && echo PASS || echo FAIL)"
  echo "Public tables:       ${TABLE_COUNT:-0}"
  echo "_prisma_migrations:  $([ "$MIGRATIONS_PRESENT" = 1 ] && echo "present, ${MIGRATIONS_COUNT:-0} row(s)" || echo "MISSING")"
  echo "StaffMember rows:    ${STAFF_COUNT:-unknown}"
  echo "AppSettings rows:    ${SETTINGS_COUNT:-unknown}"
  echo "RESULT:              $RESULT"
  if [ "$RESULT" = "PASS" ]; then
    echo
    echo "This backup restores cleanly. Uploads are NOT covered by this script"
    echo "-- see docs/DISASTER-RECOVERY.md 'Restoring uploaded files' to drill"
    echo "the uploads tarball separately, and its 'Restore drill' section for"
    echo "the optional next step of booting a throwaway app against this DB."
    mkdir -p "$BACKUP_DIR"
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$BACKUP_FILE")" >"$DRILL_MARKER"
  else
    echo
    echo "This backup did NOT verify clean. Do not check off 'restore drilled'"
    echo "in docs/PRODUCTION.md until a re-run of this script PASSes."
  fi
}

cleanup() {
  if [ "$DB_CREATED" = "1" ]; then
    echo "=== Dropping throwaway database '$DRILL_DB_NAME' ==="
    if docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS \"$DRILL_DB_NAME\";" >/dev/null 2>&1; then
      echo "  Dropped."
    else
      echo "  WARNING: drop failed -- clean up '$DRILL_DB_NAME' by hand:" >&2
      echo "    docker exec $DB_CONTAINER psql -U $DB_USER -d postgres -c 'DROP DATABASE \"$DRILL_DB_NAME\";'" >&2
    fi
  fi
  print_summary
}

# ---------------------------------------------------------------------------
# HARD GUARD -- this script must never be pointable at a real database.
# Two independent checks, deliberately redundant: an allow-list prefix
# (primary) and an explicit deny-list of known real/reserved names
# (belt-and-suspenders, in case the prefix check is ever loosened without
# someone re-deriving this list). Per CLAUDE.md rule 59 and this repo's own
# data-safety convention: saybrook, holt_saybrook, and akritos hold restored
# or seeded data and must never be written by a script; fbc_dev_db is the
# live local dev database; fbc_test_db is reserved for the Jest suite. None
# of them are acceptable restore-drill targets.
# ---------------------------------------------------------------------------
case "$DRILL_DB_NAME" in
  holt_restore_drill*) ;;
  *)
    echo "ERROR: refusing to use DRILL_DB_NAME='$DRILL_DB_NAME'." >&2
    echo "  It must start with 'holt_restore_drill' so it can never collide" >&2
    echo "  with a real database. This is a hard safety guard, not a" >&2
    echo "  suggestion -- do not work around it by renaming a real DB." >&2
    exit 1
    ;;
esac
for forbidden in saybrook holt_saybrook akritos fbc_dev_db fbc_test_db postgres template0 template1; do
  drill_lc=$(printf '%s' "$DRILL_DB_NAME" | tr '[:upper:]' '[:lower:]')
  if [ "$drill_lc" = "$forbidden" ]; then
    echo "ERROR: refusing to target '$DRILL_DB_NAME' -- it matches a real or" >&2
    echo "  reserved database name. This script only ever touches a throwaway" >&2
    echo "  database prefixed 'holt_restore_drill'." >&2
    exit 1
  fi
done
if [ "$DRILL_DB_NAME" = "$SOURCE_DB_NAME" ]; then
  echo "ERROR: DRILL_DB_NAME equals the source database name ('$SOURCE_DB_NAME')." >&2
  echo "  Refusing -- the whole point of the throwaway name is that it can" >&2
  echo "  never be the database this drill is backing up FROM." >&2
  exit 1
fi
# ---------------------------------------------------------------------------

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is not installed/on PATH -- cannot run a restore drill" >&2
  echo "  without it (this script restores into a real Postgres via" >&2
  echo "  'docker exec'). A restore drill that didn't run is not a passed" >&2
  echo "  one, so this is a hard failure, not a skip." >&2
  exit 1
fi
if ! docker exec "$DB_CONTAINER" pg_isready -U "$DB_USER" >/dev/null 2>&1; then
  echo "ERROR: Postgres container '$DB_CONTAINER' is not reachable/ready." >&2
  echo "  Set DB_CONTAINER if your container isn't named 'db' (e.g. the" >&2
  echo "  compose project name 'holt' typically yields 'holt-db-1')." >&2
  exit 1
fi

if [ -z "$BACKUP_FILE" ]; then
  echo "=== No backup file given -- taking a fresh one with scripts/backup-db.sh ==="
  echo "    (drills TODAY's backup, not an old file that might not reflect how"
  echo "     backup-db.sh currently behaves)"
  ./scripts/backup-db.sh
  BACKUP_FILE=$(ls -t "$BACKUP_DIR"/db-backup-*.sql.gz 2>/dev/null | head -1)
fi
if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: no backup file found (looked in '$BACKUP_DIR')." >&2
  exit 1
fi

echo "=== Restore drill ==="
echo "Backup file:      $BACKUP_FILE"
echo "Throwaway DB:     $DRILL_DB_NAME"
echo "Postgres:         container=$DB_CONTAINER user=$DB_USER"
echo

# From here on, every exit path (success, verification failure, or an
# unexpected command failure under `set -e`) must drop the throwaway DB and
# print the summary -- register the trap now, before anything that could
# create the database.
trap cleanup EXIT

# --- Create the throwaway database -----------------------------------------
echo "=== [1/3] Creating throwaway database ==="
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$DRILL_DB_NAME\" OWNER \"$DB_USER\";"
DB_CREATED=1
echo "  Done."

# --- Restore into it ---------------------------------------------------
echo "=== [2/3] Restoring backup into throwaway database ==="
RESTORE_LOG="$(mktemp)"
if [[ "$BACKUP_FILE" == *.gz ]]; then
  if gunzip -c "$BACKUP_FILE" | docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DRILL_DB_NAME" -v ON_ERROR_STOP=1 >"$RESTORE_LOG" 2>&1; then
    RESTORE_OK=1
  fi
else
  if docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DRILL_DB_NAME" -v ON_ERROR_STOP=1 <"$BACKUP_FILE" >"$RESTORE_LOG" 2>&1; then
    RESTORE_OK=1
  fi
fi
if [ "$RESTORE_OK" = "1" ]; then
  echo "  Restore completed without error."
else
  echo "  RESTORE FAILED -- tail of output:" >&2
  tail -20 "$RESTORE_LOG" >&2 || true
fi
rm -f "$RESTORE_LOG"

# --- Verify ------------------------------------------------------------
echo "=== [3/3] Verifying restored data ==="
VERIFY_OK=1

if TABLE_COUNT=$(psql_scalar "SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'public';") && [ -n "$TABLE_COUNT" ] && [ "$TABLE_COUNT" -gt 0 ] 2>/dev/null; then
  echo "  Public tables:        $TABLE_COUNT (PASS)"
else
  echo "  Public tables:        ${TABLE_COUNT:-0} (FAIL -- schema did not restore)"
  VERIFY_OK=0
fi

if MIGRATIONS_COUNT=$(psql_scalar 'SELECT COUNT(*) FROM "_prisma_migrations";'); then
  MIGRATIONS_PRESENT=1
  if [ -n "$MIGRATIONS_COUNT" ] && [ "$MIGRATIONS_COUNT" -gt 0 ] 2>/dev/null; then
    echo "  _prisma_migrations:   present, $MIGRATIONS_COUNT row(s) (PASS)"
  else
    echo "  _prisma_migrations:   present but EMPTY (FAIL -- looks like a pre-migration/blank DB was backed up)"
    VERIFY_OK=0
  fi
else
  echo "  _prisma_migrations:   MISSING (FAIL -- restore did not bring migration history)"
  VERIFY_OK=0
fi

# Row counts on two always-present tables -- informational rather than a
# hard pass/fail on count>0, since a legitimately fresh pre-bootstrap backup
# can have zero StaffMember/AppSettings rows. A query ERROR (table absent)
# is still a hard fail: it means the schema didn't fully restore.
if STAFF_COUNT=$(psql_scalar 'SELECT COUNT(*) FROM "StaffMember";'); then
  echo "  StaffMember rows:     ${STAFF_COUNT:-0}"
else
  echo "  StaffMember rows:     query FAILED (FAIL -- table missing)"
  VERIFY_OK=0
fi
if SETTINGS_COUNT=$(psql_scalar 'SELECT COUNT(*) FROM "AppSettings";'); then
  echo "  AppSettings rows:     ${SETTINGS_COUNT:-0}"
else
  echo "  AppSettings rows:     query FAILED (FAIL -- table missing)"
  VERIFY_OK=0
fi

if [ "$RESTORE_OK" = "1" ] && [ "$VERIFY_OK" = "1" ]; then
  RESULT="PASS"
else
  RESULT="FAIL"
fi

# print_summary + DROP run via the EXIT trap (cleanup) after this.
if [ "$RESULT" = "FAIL" ]; then
  exit 1
fi
exit 0
