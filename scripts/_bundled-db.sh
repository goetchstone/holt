#!/bin/sh
# scripts/_bundled-db.sh
#
# Shared by backup-db.sh and restore-db.sh. Source it, then call:
#
#   require_bundled_db
#
# Both scripts work on the compose `db` container (docker compose ps -q db).
# When the app's DATABASE_URL names another database -- a managed Postgres
# (docs/HOSTING.md, ~75-250 staff) -- that container is still started by compose,
# empty, and the app never reads it. A backup then dumped the empty database,
# passed its own completeness check and reported a good backup; a restore went
# into a database the app does not use. So when DATABASE_URL's host is anything
# but `db`, refuse and say why. Use the database provider's own backups there.
#
# DATABASE_URL comes from the environment, or else from the root .env: the same
# order docker-compose.yml's ${DATABASE_URL} is filled in for the app. No
# DATABASE_URL at all: nothing to compare, so the scripts behave as before.
# `localhost` and `127.0.0.1` pass too: from the host, that is how a developer
# reaches the same container (published on 5433).

require_bundled_db() {
  url="${DATABASE_URL:-}"
  if [ -z "$url" ] && [ -f .env ]; then
    url=$(grep -E '^DATABASE_URL=' .env | tail -n 1 | cut -d= -f2- | tr -d "\"'")
  fi
  [ -n "$url" ] || return 0
  # scheme://[user[:password]@]host[:port]/name?options -- the authority is
  # everything before the first "/", and the host is after its last "@".
  host=$(printf '%s' "$url" | sed -E 's#^[A-Za-z+]+://##; s#[/?].*$##; s#^.*@##; s#:[0-9]*$##')
  case "$host" in
    db | localhost | 127.0.0.1) return 0 ;;
  esac
  echo "ERROR: the app's DATABASE_URL points at '$host', not this stack's own 'db' service." >&2
  echo "  This script only reaches the bundled database container, so it would work on a" >&2
  echo "  database the app does not use. Use your database provider's backups and restore" >&2
  echo "  instead (docs/HOSTING.md, 'A managed database'). scripts/deploy.sh runs this" >&2
  echo "  backup first: once the provider's backups are on, deploy with SKIP_BACKUP=1." >&2
  return 1
}
