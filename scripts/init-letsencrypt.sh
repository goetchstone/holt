#!/usr/bin/env bash
# scripts/init-letsencrypt.sh
#
# Bootstraps (and renews) the Let's Encrypt TLS certificate that
# nginx/nginx.conf's 443 server block expects at
# /etc/letsencrypt/live/<domain>/{fullchain,privkey}.pem. Run from the
# repository root on the host that runs the containers.
#
# WHY this script exists (the chicken-and-egg problem):
#   nginx/nginx.conf's 443 server block references cert files that don't
#   exist yet, so nginx (as shipped) refuses to start at all -- including
#   its port-80 block, which is exactly what certbot needs to answer the
#   HTTP-01 challenge to ISSUE that cert. To break the cycle this script:
#     1. Writes a throwaway self-signed "dummy" cert to the exact path
#        nginx expects, purely so nginx has something to load.
#     2. Starts nginx against the real nginx.conf (now it boots fine).
#     3. Deletes the dummy cert and asks certbot to request the real one
#        via the HTTP-01 webroot challenge, which the now-running nginx
#        answers on port 80.
#     4. Reloads nginx so it picks up the real cert -- no restart, no
#        dropped connections.
#   Re-running with a cert already present is a no-op (see --force).
#
# Prerequisites:
#   - Docker + Docker Compose, and the `certbot` service's image reachable
#     (docker-compose.yml, profile "tls").
#   - DNS for <domain> already points at this host, and ports 80 + 443 are
#     reachable from the internet on it (see docker-compose.yml comment on
#     the nginx service ports -- this is why they're 80/443, not 8080).
#   - nginx/nginx.conf has had REPLACE_ME_DOMAIN substituted for <domain>
#     (this script checks and refuses to continue if it hasn't been).
#
# Usage:
#   ./scripts/init-letsencrypt.sh <domain> <email> [--staging] [--force]
#   ./scripts/init-letsencrypt.sh --renew
#
#   <domain>   the public hostname, e.g. example.com (must match
#              nginx/nginx.conf's REPLACE_ME_DOMAIN substitution exactly)
#   <email>    address Let's Encrypt uses for expiry/problem notices
#   --staging  use Let's Encrypt's STAGING environment (untrusted certs,
#              but no rate limit) -- use this to rehearse the whole flow
#              before spending your real quota. This is Let's Encrypt's
#              staging, unrelated to Holt's own `--profile staging` app
#              environment.
#   --force    re-issue even if a cert already exists for <domain>
#   --renew    skip issuance; run `certbot renew` + reload nginx. This is
#              what you put in cron/Task Scheduler (see bottom of this file).
#
# Example cron (twice daily, certbot only actually renews inside its last
# 30 days of validity, so this is safe to run often):
#   17 3,15 * * * cd /path/to/holt && ./scripts/init-letsencrypt.sh --renew >> ./backups/certbot-renew.log 2>&1

set -euo pipefail

COMPOSE="docker compose"
NGINX_CONF="nginx/nginx.conf"
# docker-compose.yml pins `name: holt` so the compose-managed volumes are
# always "holt_<name>" regardless of what directory/worktree this is
# checked out into (do NOT derive this from $(pwd) -- worktrees and forks
# get their own directory names, but the compose project name is fixed).
COMPOSE_PROJECT="holt"
CERTBOT_ETC_VOLUME="${COMPOSE_PROJECT}_certbot-etc"

usage() {
  echo "Usage:" >&2
  echo "  $0 <domain> <email> [--staging] [--force]" >&2
  echo "  $0 --renew" >&2
  exit 1
}

# --- Mode: renewal (cron path) --------------------------------------------
if [ "${1:-}" = "--renew" ]; then
  echo "=== Renewing certificate(s) (no-op unless within 30 days of expiry) ==="
  $COMPOSE --profile tls run --rm certbot renew
  echo "=== Reloading nginx to pick up any renewed cert ==="
  $COMPOSE exec nginx nginx -s reload
  echo "OK — renewal check complete."
  exit 0
fi

# --- Mode: first issuance / re-issuance ------------------------------------
if [ $# -lt 2 ]; then
  usage
fi

DOMAIN="$1"
EMAIL="$2"
shift 2

STAGING_FLAG=""
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --staging) STAGING_FLAG="--staging" ;;
    --force) FORCE=1 ;;
    *)
      echo "ERROR: unrecognized argument '$arg'" >&2
      usage
      ;;
  esac
done

if [ ! -f "$NGINX_CONF" ]; then
  echo "ERROR: $NGINX_CONF not found. Run this from the repository root." >&2
  exit 1
fi

# Safety net: catch the two most likely deploy-day mistakes before touching
# anything -- forgetting to substitute the domain, or substituting a
# different domain than the one passed on the command line.
if grep -q "REPLACE_ME_DOMAIN" "$NGINX_CONF"; then
  echo "ERROR: $NGINX_CONF still contains REPLACE_ME_DOMAIN." >&2
  echo "  Substitute your real domain first, e.g.:" >&2
  echo "    sed -i '' 's/REPLACE_ME_DOMAIN/$DOMAIN/g' $NGINX_CONF   # macOS" >&2
  echo "    sed -i 's/REPLACE_ME_DOMAIN/$DOMAIN/g' $NGINX_CONF      # Linux" >&2
  exit 1
fi
if ! grep -q "live/$DOMAIN/" "$NGINX_CONF"; then
  echo "ERROR: $NGINX_CONF's ssl_certificate paths don't reference 'live/$DOMAIN/'." >&2
  echo "  It was substituted with a different domain than '$DOMAIN'. Fix $NGINX_CONF" >&2
  echo "  (or re-run this script with the domain it actually contains) before continuing." >&2
  exit 1
fi

# Idempotency: skip straight to a no-op if a real cert is already there,
# unless --force. (The dummy cert from a previous interrupted run doesn't
# count -- it's 1 day and self-signed; check for a certbot-issued lineage
# via the renewal conf certbot itself writes.)
CERT_EXISTS=$($COMPOSE --profile tls run --rm --entrypoint sh certbot \
  -c "test -f /etc/letsencrypt/renewal/$DOMAIN.conf && echo yes || echo no" | tr -d '\r')
if [ "$CERT_EXISTS" = "yes" ] && [ "$FORCE" -ne 1 ]; then
  echo "A certbot-managed certificate for '$DOMAIN' already exists."
  echo "Nothing to do. Use --force to re-issue, or --renew for the renewal path."
  exit 0
fi

echo "=== [1/5] Writing a throwaway self-signed cert so nginx can start ==="
# openssl isn't guaranteed to be in nginx:alpine or certbot's image, so use
# a plain alpine image and install it on the fly -- this container is
# discarded immediately after. (The CERT_EXISTS check above already forced
# `docker compose run` to provision the certbot-etc volume if it didn't
# exist, so it's safe to reference by name here.)
#
# Note for --force on an already-live deployment: this overwrites the cert
# FILES in the volume, but nginx keeps serving whatever it already has
# loaded in memory until the explicit `nginx -s reload` in step 5 -- so
# there is no window where real traffic is served the dummy cert.
docker run --rm \
  -v "$CERTBOT_ETC_VOLUME:/etc/letsencrypt" \
  alpine:3.20 sh -c "
    apk add --no-cache openssl >/dev/null &&
    mkdir -p /etc/letsencrypt/live/$DOMAIN &&
    openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
      -keyout /etc/letsencrypt/live/$DOMAIN/privkey.pem \
      -out /etc/letsencrypt/live/$DOMAIN/fullchain.pem \
      -subj '/CN=$DOMAIN' &&
    cp /etc/letsencrypt/live/$DOMAIN/fullchain.pem /etc/letsencrypt/live/$DOMAIN/chain.pem
  "

echo "=== [2/5] Starting nginx (it can now load the dummy cert) ==="
$COMPOSE up -d nginx

echo "=== [3/5] Deleting the dummy cert so certbot requests a clean lineage ==="
docker run --rm \
  -v "$CERTBOT_ETC_VOLUME:/etc/letsencrypt" \
  alpine:3.20 sh -c "rm -rf /etc/letsencrypt/live/$DOMAIN /etc/letsencrypt/archive/$DOMAIN /etc/letsencrypt/renewal/$DOMAIN.conf"

echo "=== [4/5] Requesting the real certificate from Let's Encrypt (webroot HTTP-01) ==="
if [ -n "$STAGING_FLAG" ]; then
  echo "    (using Let's Encrypt STAGING -- cert will NOT be trusted by browsers)"
fi
$COMPOSE --profile tls run --rm certbot certonly \
  --webroot -w /var/www/certbot \
  -d "$DOMAIN" \
  --email "$EMAIL" \
  --rsa-key-size 4096 \
  --agree-tos \
  --no-eff-email \
  --force-renewal \
  $STAGING_FLAG

echo "=== [5/5] Reloading nginx with the real certificate ==="
$COMPOSE exec nginx nginx -s reload

echo "OK — $DOMAIN is issued$( [ -n "$STAGING_FLAG" ] && echo " (STAGING — re-run without --staging for a browser-trusted cert)" )."
echo "Schedule renewal: cron entry calling '$0 --renew' (see the comment block at the top of this file)."
