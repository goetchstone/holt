#!/bin/sh
# scripts/_cron-run.sh
#
# Shared helper for the auto-*.sh cron scripts. Source it, then call:
#
#   run_cron "<job-name>" "<api-path>" [json-body]
#
# e.g.  run_cron "email-queue" "/api/automations/email-queue"
#       run_cron "daily-reconciliation" "/api/automations/daily-reconciliation" '{}'
#
# It POSTs to the local app with the Bearer AUTO_IMPORT_API_KEY, then treats the
# run as FAILED when the HTTP status is not 2xx OR the JSON body contains an
# "error" field. On failure it logs the status + body and, if OPS_ALERT_WEBHOOK
# is set, posts an alert there before exiting non-zero — so a silently-broken
# cron (the email queue never draining, books not tying out) becomes a ping the
# owner actually sees, not a line buried in a log nobody reads.
#
# Required env: AUTO_IMPORT_API_KEY (matches app/.env.local).
# Optional env: APP_BASE_URL (default http://localhost:3000),
#               OPS_ALERT_WEBHOOK (Slack/Discord/any JSON endpoint).

run_cron() {
  job_name="$1"
  api_path="$2"
  json_body="${3:-}"

  if [ -z "${AUTO_IMPORT_API_KEY:-}" ]; then
    echo "ERROR [$job_name]: AUTO_IMPORT_API_KEY is not set" >&2
    return 1
  fi

  base_url="${APP_BASE_URL:-http://localhost:3000}"
  url="${base_url}${api_path}"

  # Capture body and HTTP status in one request. The body is everything before
  # the final line; the status is the final line (written by -w). An optional
  # JSON body is sent with a matching Content-Type when provided.
  if [ -n "$json_body" ]; then
    response=$(curl -s -w '\n%{http_code}' -X POST \
      -H "Authorization: Bearer ${AUTO_IMPORT_API_KEY}" \
      -H "Content-Type: application/json" \
      -d "$json_body" \
      "$url")
  else
    response=$(curl -s -w '\n%{http_code}' -X POST \
      -H "Authorization: Bearer ${AUTO_IMPORT_API_KEY}" \
      "$url")
  fi
  http_status=$(printf '%s' "$response" | tail -n1)
  body=$(printf '%s' "$response" | sed '$d')

  ok=1
  case "$http_status" in
    2*) ;;
    *) ok=0 ;;
  esac
  # A 200 that still carries an {"error": ...} is a failure (some endpoints
  # report partial failure in the body).
  if printf '%s' "$body" | grep -q '"error"'; then
    ok=0
  fi

  if [ "$ok" = "1" ]; then
    echo "OK [$job_name] status=$http_status $body"
    return 0
  fi

  echo "FAILED [$job_name] status=$http_status $body" >&2

  if [ -n "${OPS_ALERT_WEBHOOK:-}" ]; then
    # Build a minimal JSON payload. Escape the body's quotes/newlines crudely so
    # it survives as a single JSON string; the webhook only needs it legible.
    safe_body=$(printf '%s' "$body" | tr '\n' ' ' | sed 's/"/\\"/g' | cut -c1-500)
    curl -s -X POST -H "Content-Type: application/json" \
      -d "{\"text\":\"[Holt cron] ${job_name} failed (status ${http_status})\",\"detail\":\"${safe_body}\"}" \
      "$OPS_ALERT_WEBHOOK" >/dev/null 2>&1 || \
      echo "WARN [$job_name]: ops alert webhook delivery failed" >&2
  fi

  return 1
}
