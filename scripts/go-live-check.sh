#!/usr/bin/env bash
# scripts/go-live-check.sh
#
# Verify the docs/PRODUCTION.md "is it safe to take money?" nine-condition
# gate: "TLS on · backups scheduled + one restore drilled · uploads backed
# up · auto-email-queue.sh running · ops alert channel set · live Stripe
# keys + webhook secret + AR GL mappings configured · create-admin done."
#
# Checks what's actually machine-checkable from this host and reports
# PASS/FAIL for those. Anything that requires knowledge this host can't
# have (is a Stripe key really LIVE, are the GL mappings semantically
# correct) prints as MANUAL, never as a pass -- a MANUAL line is not
# evidence of anything, it's a reminder.
#
# Usage:
#   ./scripts/go-live-check.sh [--base-url http://localhost:3000]
#
# Exit: 0 only if every AUTOMATED check passed (MANUAL items don't affect
# the exit code -- they can't be verified from here by definition). Suitable
# as a deploy gate: `./scripts/go-live-check.sh --base-url https://... || exit 1`
#
# NEVER prints secret values -- env var checks report presence/length only.
# Degrades gracefully when optional tooling (docker, openssl, curl,
# crontab) is missing: that check prints MANUAL with instructions instead
# of crashing, since a check that couldn't run is not a passed check.

set -uo pipefail
# (No `set -e`: this script deliberately keeps going after a failed check
# so one bad condition doesn't hide the other eight.)

REPO_ROOT=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

BASE_URL="http://localhost:3000"
while [ $# -gt 0 ]; do
  case "$1" in
    --base-url)
      BASE_URL="${2:-}"
      shift 2
      ;;
    --base-url=*)
      BASE_URL="${1#--base-url=}"
      shift
      ;;
    -h | --help)
      echo "Usage: $0 [--base-url http://localhost:3000]" >&2
      exit 0
      ;;
    *)
      echo "ERROR: unrecognized argument '$1'" >&2
      exit 1
      ;;
  esac
done
BASE_URL="${BASE_URL%/}"

# Same DB connection defaults as scripts/backup-db.sh -- this script only
# ever runs read-only SELECTs against the real database (create-admin
# check), never a write, so it doesn't need restore-drill.sh's guard.
DB_CONTAINER="${DB_CONTAINER:-db}"
DB_USER="${POSTGRES_USER:-app}"
DB_NAME="${POSTGRES_DB:-app}"

# --- Thresholds --------------------------------------------------------
# None of these are stated as exact numbers anywhere in docs/PRODUCTION.md
# or docs/DISASTER-RECOVERY.md -- they're this script's own judgment calls,
# flagged here rather than presented as derived facts:
BACKUP_STALE_HOURS=30 # DISASTER-RECOVERY.md states a 24h RPO; +6h grace
                       # for a job that's merely running a bit late.
UPLOADS_STALE_HOURS=30 # Mirrors the DB window -- docs schedule uploads
                        # backup 10 min after the DB backup, no separate RPO.
DRILL_STALE_DAYS=90 # Docs say "re-drill after any backup-script change"
                     # (event-driven) but give no periodic cadence; 90 days
                     # (roughly quarterly) is this script's own default.
TLS_WARN_SECONDS=$((14 * 86400)) # 14 days. certbot's own renewal window is
                                  # 30 days out (init-letsencrypt.sh); being
                                  # inside 14 days means auto-renewal should
                                  # already have fired and evidently hasn't.

# --- Reporting -----------------------------------------------------------
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0
MANUAL_COUNT=0
pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "[PASS]   $1"
}
fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "[FAIL]   $1"
}
warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  echo "[WARN]   $1"
}
skip() {
  echo "[SKIP]   $1"
}
manual() {
  MANUAL_COUNT=$((MANUAL_COUNT + 1))
  echo "[MANUAL] $1"
}

# --- Small portable helpers ------------------------------------------------
# mtime/now as epoch seconds -- GNU stat/date first, BSD (macOS) fallback.
file_mtime_epoch() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null; }
iso_to_epoch() { date -d "$1" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%SZ" "$1" +%s 2>/dev/null; }

# Read KEY from the current environment, else app/.env.local, else .env
# (both are what docker-compose.yml's app service reads, per env_file:).
# Value is returned on stdout for the CALLER to measure/compare -- never
# echoed by this script itself.
env_value() {
  local key="$1" f line
  if [ -n "${!key:-}" ]; then
    printf '%s' "${!key}"
    return 0
  fi
  for f in "$REPO_ROOT/app/.env.local" "$REPO_ROOT/.env"; do
    if [ -f "$f" ]; then
      line=$(grep -E "^${key}=" "$f" 2>/dev/null | tail -1 || true)
      if [ -n "$line" ]; then
        printf '%s' "${line#*=}"
        return 0
      fi
    fi
  done
  return 1
}

json_field() {
  # $1 = JSON body (compact, no nesting below one level -- matches
  # /api/health's shape), $2 = key. String values only.
  printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -1 | cut -d'"' -f4
}

echo "=== Holt go-live check -- $BASE_URL ==="
echo "(docs/PRODUCTION.md 'is it safe to take money?' gate)"
echo

# ===========================================================================
# Section A -- app reachability & the env vars the app itself requires to
# boot (lib/validateEnv.ts) or that the cron/alerting layer needs. Not
# literally one of the nine gate conditions, but everything below assumes
# the app is even up.
# ===========================================================================
echo "--- App & environment ---"

HEALTH_BODY=""
if command -v curl >/dev/null 2>&1; then
  # curl itself writes "000" via -w when it can't connect at all, so the
  # fallback here only covers curl not being invocable -- don't ALSO
  # append "000" on top of curl's own "000" (that doubled the digits).
  READY_CODE=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 "$BASE_URL/api/health?ready=1" 2>/dev/null)
  READY_CODE="${READY_CODE:-000}"
  if [ "$READY_CODE" = "200" ]; then
    pass "App health (/api/health?ready=1): 200"
  else
    fail "App health (/api/health?ready=1): got HTTP $READY_CODE, expected 200"
  fi
  HEALTH_BODY=$(curl -sS --connect-timeout 5 "$BASE_URL/api/health" 2>/dev/null || true)
else
  manual "App health -- curl not available on this host. Verify by hand: curl $BASE_URL/api/health?ready=1"
fi

check_env_var() {
  local key="$1" minlen="${2:-1}" label="${3:-$1}"
  local val
  if val=$(env_value "$key") && [ -n "$val" ] && [ "${#val}" -ge "$minlen" ]; then
    pass "$label is set (${#val} chars)"
  else
    fail "$label is missing$([ "$minlen" -gt 1 ] && echo " or shorter than $minlen chars"). Set it in app/.env.local or .env (see env.example)."
  fi
}
check_env_var DATABASE_URL 1 "DATABASE_URL"
check_env_var NEXTAUTH_SECRET 16 "NEXTAUTH_SECRET"
check_env_var APP_ENCRYPTION_KEY 16 "APP_ENCRYPTION_KEY"

NEXTAUTH_URL_VAL=$(env_value NEXTAUTH_URL || true)
if [ -z "$NEXTAUTH_URL_VAL" ]; then
  fail "NEXTAUTH_URL is not set (required in production; see lib/validateEnv.ts)."
elif [[ "$NEXTAUTH_URL_VAL" != https://* ]]; then
  fail "NEXTAUTH_URL is set but doesn't start with https:// (required in production)."
else
  pass "NEXTAUTH_URL is set and https://"
fi
unset NEXTAUTH_URL_VAL

TRUST_PROXY_VAL=$(env_value TRUST_PROXY || true)
if [ "$TRUST_PROXY_VAL" = "true" ]; then
  pass "TRUST_PROXY=true"
else
  fail "TRUST_PROXY is not 'true' -- rate-limit IP attribution will trust the spoofable socket IP instead of nginx's real-IP header."
fi
unset TRUST_PROXY_VAL

check_env_var AUTO_IMPORT_API_KEY 1 "AUTO_IMPORT_API_KEY (cron auth)"
echo

# ===========================================================================
# Section B -- the nine-condition gate, in docs/PRODUCTION.md's order.
# ===========================================================================
echo "--- The nine-condition go-live gate ---"

# [1/9] TLS on
HOST="${BASE_URL#*://}"
HOST="${HOST%%/*}"
HOST="${HOST%%:*}"
case "$HOST" in
  localhost | 127.0.0.1 | 127.*)
    skip "[1/9] TLS on -- base-url host is '$HOST' (local). Re-run with --base-url https://<your-domain> to check the real cert."
    ;;
  *)
    if ! command -v openssl >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
      manual "[1/9] TLS on -- openssl and/or curl not available to check the cert on $HOST:443. Verify by hand."
    elif ! curl -sS -o /dev/null --connect-timeout 5 "https://$HOST/" 2>/dev/null; then
      fail "[1/9] TLS on -- https://$HOST/ was not reachable within 5s (DNS/port 80→443 routing/cert issue)."
    else
      CERT=$(openssl s_client -connect "$HOST:443" -servername "$HOST" </dev/null 2>/dev/null | openssl x509 2>/dev/null || true)
      if [ -z "$CERT" ]; then
        fail "[1/9] TLS on -- reachable on 443 but could not read a certificate."
      elif ! printf '%s' "$CERT" | openssl x509 -noout -checkend 0 >/dev/null 2>&1; then
        fail "[1/9] TLS on -- certificate for $HOST has EXPIRED."
      else
        ENDDATE=$(printf '%s' "$CERT" | openssl x509 -noout -enddate 2>/dev/null | sed 's/^notAfter=//')
        if printf '%s' "$CERT" | openssl x509 -noout -checkend "$TLS_WARN_SECONDS" >/dev/null 2>&1; then
          pass "[1/9] TLS on -- valid certificate on 443, expires $ENDDATE"
        else
          warn "[1/9] TLS on -- certificate expires within $((TLS_WARN_SECONDS / 86400)) days ($ENDDATE). Renew: ./scripts/init-letsencrypt.sh --renew"
        fi
      fi
    fi
    ;;
esac

# [2/9] Backups scheduled
BACKUP_DIR="$REPO_ROOT/backups"
NEWEST_DB_BACKUP=$(ls -t "$BACKUP_DIR"/db-backup-*.sql.gz 2>/dev/null | head -1 || true)
if [ -z "$NEWEST_DB_BACKUP" ]; then
  fail "[2/9] Backups scheduled -- no db-backup-*.sql.gz found in backups/. Run ./scripts/backup-db.sh and schedule it (docs/DISASTER-RECOVERY.md)."
else
  MTIME=$(file_mtime_epoch "$NEWEST_DB_BACKUP")
  AGE_H=$(( ($(date +%s) - MTIME) / 3600 ))
  if [ "$AGE_H" -le "$BACKUP_STALE_HOURS" ]; then
    pass "[2/9] Backups scheduled -- newest is $(basename "$NEWEST_DB_BACKUP"), ${AGE_H}h old"
  else
    fail "[2/9] Backups scheduled -- newest backup ($(basename "$NEWEST_DB_BACKUP")) is ${AGE_H}h old (> ${BACKUP_STALE_HOURS}h). Is the backup cron actually running?"
  fi
fi

# [3/9] One restore drilled
DRILL_MARKER="$BACKUP_DIR/.last-restore-drill"
if [ ! -f "$DRILL_MARKER" ]; then
  fail "[3/9] One restore drilled -- no record at backups/.last-restore-drill. Run ./scripts/restore-drill.sh."
else
  DRILL_LINE=$(cat "$DRILL_MARKER" 2>/dev/null || true)
  DRILL_TS=$(printf '%s' "$DRILL_LINE" | awk '{print $1}')
  DRILL_EPOCH=$(iso_to_epoch "$DRILL_TS" || true)
  if [ -z "$DRILL_EPOCH" ]; then
    warn "[3/9] One restore drilled -- record found ('$DRILL_LINE') but its timestamp couldn't be parsed to check staleness."
  else
    AGE_D=$(( ($(date +%s) - DRILL_EPOCH) / 86400 ))
    if [ "$AGE_D" -le "$DRILL_STALE_DAYS" ]; then
      pass "[3/9] One restore drilled -- last PASS $AGE_D day(s) ago ($DRILL_LINE)"
    else
      fail "[3/9] One restore drilled -- last recorded PASS was $AGE_D day(s) ago (> ${DRILL_STALE_DAYS}d). Re-run ./scripts/restore-drill.sh."
    fi
  fi
fi

# [4/9] Uploads backed up
NEWEST_UPLOADS_BACKUP=$(ls -t "$BACKUP_DIR"/uploads-backup-*.tgz 2>/dev/null | head -1 || true)
if [ -z "$NEWEST_UPLOADS_BACKUP" ]; then
  fail "[4/9] Uploads backed up -- no uploads-backup-*.tgz found in backups/. Run ./scripts/backup-uploads.sh and schedule it."
else
  MTIME=$(file_mtime_epoch "$NEWEST_UPLOADS_BACKUP")
  AGE_H=$(( ($(date +%s) - MTIME) / 3600 ))
  if [ "$AGE_H" -le "$UPLOADS_STALE_HOURS" ]; then
    pass "[4/9] Uploads backed up -- newest is $(basename "$NEWEST_UPLOADS_BACKUP"), ${AGE_H}h old"
  else
    fail "[4/9] Uploads backed up -- newest backup ($(basename "$NEWEST_UPLOADS_BACKUP")) is ${AGE_H}h old (> ${UPLOADS_STALE_HOURS}h)."
  fi
fi

# [5/9] auto-email-queue.sh running (cron)
if ! command -v crontab >/dev/null 2>&1; then
  manual "[5/9] auto-email-queue.sh running -- 'crontab' isn't available on this host to inspect. Verify by hand."
else
  CRONTAB_OUT=$(crontab -l 2>/dev/null || true)
  if [ -z "$CRONTAB_OUT" ]; then
    fail "[5/9] auto-email-queue.sh running -- no crontab installed for this user. Run ./scripts/install-cron.sh."
  elif printf '%s' "$CRONTAB_OUT" | grep -q '# >>> holt cron >>>' && printf '%s' "$CRONTAB_OUT" | grep -q 'auto-email-queue.sh'; then
    pass "[5/9] auto-email-queue.sh running -- managed cron block present and contains the job"
  else
    fail "[5/9] auto-email-queue.sh running -- managed holt cron block missing or doesn't contain auto-email-queue.sh. Run ./scripts/install-cron.sh."
  fi
fi

# [6/9] Ops alert channel set
OPS_WEBHOOK_VAL=$(env_value OPS_ALERT_WEBHOOK || true)
OPS_EMAIL_VAL=$(env_value OPS_ALERT_EMAIL || true)
if [ -n "$OPS_WEBHOOK_VAL" ] || [ -n "$OPS_EMAIL_VAL" ]; then
  pass "[6/9] Ops alert channel set -- $([ -n "$OPS_WEBHOOK_VAL" ] && echo -n "OPS_ALERT_WEBHOOK ")$([ -n "$OPS_EMAIL_VAL" ] && echo -n "OPS_ALERT_EMAIL")configured"
else
  fail "[6/9] Ops alert channel set -- neither OPS_ALERT_WEBHOOK nor OPS_ALERT_EMAIL is set. Alerts log only; failures go unnoticed."
fi
unset OPS_WEBHOOK_VAL OPS_EMAIL_VAL

# [7/9] Live Stripe keys + webhook secret configured
manual "[7/9] Live Stripe keys + webhook secret -- cannot be verified from this host (whether a stored key is genuinely LIVE vs test mode isn't host-inspectable). Verify by hand: Settings -> Integrations shows live keys (pk_live_/sk_live_, not _test_) and the webhook endpoint https://<domain>/api/stripe/webhook is registered in the Stripe dashboard with a matching signing secret."

# [8/9] AR GL mappings configured
BILLING_STATUS=""
if [ -n "$HEALTH_BODY" ]; then
  BILLING_STATUS=$(json_field "$HEALTH_BODY" "billing")
fi
case "$BILLING_STATUS" in
  ok)
    manual "[8/9] AR GL mappings configured -- MANUAL per policy, but /api/health reports billing=\"ok\" (AR + revenue GL accounts resolve) as a supporting signal, not a substitute for confirming the mappings point at the RIGHT accounts."
    ;;
  unconfigured)
    manual "[8/9] AR GL mappings configured -- /api/health reports billing=\"unconfigured\" (required AR_TRANSACTIONS mappings missing). Configure them in Admin -> Setup -> Accounting before issuing invoices."
    ;;
  disabled)
    manual "[8/9] AR GL mappings configured -- billing feature module is off (/api/health billing=\"disabled\"); not applicable until it's enabled."
    ;;
  *)
    manual "[8/9] AR GL mappings configured -- cannot be verified from this host beyond what /api/health reports (unavailable here). Verify by hand in Admin -> Setup -> Accounting."
    ;;
esac

# [9/9] create-admin done
ADMIN_QUERY='SELECT COUNT(*) FROM "StaffMember" WHERE role IN ('"'"'ADMIN'"'"','"'"'SUPER_ADMIN'"'"') AND "isActive" = true;'
ADMIN_COUNT=""
if command -v docker >/dev/null 2>&1 && docker exec "$DB_CONTAINER" pg_isready -U "$DB_USER" >/dev/null 2>&1; then
  ADMIN_COUNT=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A -c "$ADMIN_QUERY" 2>/dev/null || true)
elif command -v psql >/dev/null 2>&1 && [ -n "$(env_value DATABASE_URL || true)" ]; then
  ADMIN_COUNT=$(psql "$(env_value DATABASE_URL)" -t -A -c "$ADMIN_QUERY" 2>/dev/null || true)
fi
if [ -n "$ADMIN_COUNT" ] && [ "$ADMIN_COUNT" -gt 0 ] 2>/dev/null; then
  pass "[9/9] create-admin done -- $ADMIN_COUNT active ADMIN/SUPER_ADMIN staff row(s)"
elif [ -n "$ADMIN_COUNT" ]; then
  fail "[9/9] create-admin done -- 0 active ADMIN/SUPER_ADMIN rows. Run: cd app && npm run create-admin <email> <password>"
else
  manual "[9/9] create-admin done -- could not query the database (docker unreachable and no local psql+DATABASE_URL). Verify by hand: SELECT COUNT(*) FROM \"StaffMember\" WHERE role IN ('ADMIN','SUPER_ADMIN') AND \"isActive\"=true;"
fi

echo
echo "=== Summary ==="
echo "PASS: $PASS_COUNT   FAIL: $FAIL_COUNT   WARN: $WARN_COUNT   MANUAL (needs a human): $MANUAL_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "RESULT: NOT READY -- $FAIL_COUNT automated check(s) failed. Fix them and re-run."
  exit 1
fi
echo "RESULT: automated checks PASS. $MANUAL_COUNT item(s) still need a human to confirm before go-live (see [MANUAL] lines above)."
exit 0
