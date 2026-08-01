#!/usr/bin/env bash
# scripts/sonar-set-gate.sh
#
# Configure the "Holt realistic" SonarQube quality gate and bind the holt project
# to it. Idempotent -- safe to re-run; it wipes and re-applies the conditions.
#
# Realistic gate (per owner direction): pass on ratings A + coverage + duplication,
# NOT on a raw new-issue count (a single new minor issue shouldn't red-gate a PR).
#   - Reliability / Security / Maintainability rating on New Code = A
#   - Coverage on New Code      >= 40%
#   - Duplicated Lines New Code <= 3%
# (new_violations and security_hotspots_reviewed are intentionally omitted; add the
#  hotspot condition once the secureUpload finding is marked Safe.)
#
# Requires an ADMIN token with "Administer Quality Gates". The analysis token in
# app/.env.local (SONAR_TOKEN) is NOT sufficient. Provide an admin token via:
#   export SONAR_ADMIN_TOKEN=...     (or add a SONAR_ADMIN_TOKEN= line to app/.env.local)
set -euo pipefail

B="${SONAR_URL:-http://localhost:9000}"
GATE="Holt realistic"
PROJECT="holt"

T="${SONAR_ADMIN_TOKEN:-}"
if [ -z "$T" ] && [ -f app/.env.local ]; then
  T=$(grep -E '^SONAR_ADMIN_TOKEN=' app/.env.local | head -1 | cut -d= -f2- | tr -d '"'\' " ')
fi
[ -n "$T" ] || { echo "ERROR: no admin token. Set SONAR_ADMIN_TOKEN (env or app/.env.local)."; exit 1; }

api() { curl -s -u "$T:" "$@"; }
pyget() { python3 -c "import sys,json;$1"; }

can=$(api "$B/api/qualitygates/list" | pyget "print(json.load(sys.stdin).get('actions',{}).get('create'))")
[ "$can" = "True" ] || { echo "ERROR: token lacks 'Administer Quality Gates' (actions.create=$can)."; exit 2; }

exists=$(api "$B/api/qualitygates/list" | pyget "print(any(g['name']=='$GATE' for g in json.load(sys.stdin)['qualitygates']))")
if [ "$exists" != "True" ]; then
  echo "Creating gate '$GATE'..."
  api -X POST "$B/api/qualitygates/create" --data-urlencode "name=$GATE" >/dev/null
fi

echo "Clearing existing conditions..."
api -G "$B/api/qualitygates/show" --data-urlencode "name=$GATE" \
  | pyget "[print(c['id']) for c in json.load(sys.stdin).get('conditions',[])]" \
  | while read -r cid; do api -X POST "$B/api/qualitygates/delete_condition" --data-urlencode "id=$cid" >/dev/null; done

add() { # metric op error
  api -X POST "$B/api/qualitygates/create_condition" \
    --data-urlencode "gateName=$GATE" --data-urlencode "metric=$1" \
    --data-urlencode "op=$2" --data-urlencode "error=$3" \
    | pyget "d=json.load(sys.stdin);print('  + $1 $2 $3') if d.get('id') else print('  ! $1 FAILED',d.get('errors'))"
}
# rating: prefer MQR metric key (SonarQube 10.8+/26.x default), fall back to legacy
add_rating() { # legacy mqr
  out=$(api -X POST "$B/api/qualitygates/create_condition" --data-urlencode "gateName=$GATE" \
        --data-urlencode "metric=$2" --data-urlencode "op=GT" --data-urlencode "error=1")
  if echo "$out" | grep -q '"id"'; then echo "  + $2 = A"; else
    api -X POST "$B/api/qualitygates/create_condition" --data-urlencode "gateName=$GATE" \
      --data-urlencode "metric=$1" --data-urlencode "op=GT" --data-urlencode "error=1" >/dev/null && echo "  + $1 = A"
  fi
}

echo "Applying conditions..."
add_rating new_reliability_rating     new_software_quality_reliability_rating
add_rating new_security_rating        new_software_quality_security_rating
add_rating new_maintainability_rating new_software_quality_maintainability_rating
add new_coverage LT 40
add new_duplicated_lines_density GT 3

echo "Binding project '$PROJECT' to the gate..."
out=$(api -X POST "$B/api/qualitygates/select" --data-urlencode "gateName=$GATE" --data-urlencode "projectKey=$PROJECT")
[ -z "$out" ] && echo "  bound" || echo "  note: $out (binds after the first scan if the project doesn't exist yet)"

echo "=== resulting gate ==="
api -G "$B/api/qualitygates/show" --data-urlencode "name=$GATE" | python3 -m json.tool
