#!/usr/bin/env bash
# End-to-end smoke test of the COMPILED build (dist/) against a real Redis.
# Requires: `npm run build`, Redis at $REDIS_URL (default redis://127.0.0.1:6379).
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f dist/src/server.js ] || { echo "dist/ missing: run npm run build first" >&2; exit 1; }
[ -f .dev/gateway.env ] || node scripts/dev-keys.mjs

# Load test-only JWT settings. Not `source`: the PEM value contains spaces.
while IFS='=' read -r key value; do
  [ -n "$key" ] && export "$key=$value"
done < .dev/gateway.env

GW_PORT=3100 A_PORT=4101 B_PORT=4102
LOGDIR="$(mktemp -d)"
PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT

PORT=$A_PORT node dist/services/service-a/index.js >"$LOGDIR/a.log" 2>&1 & PIDS+=($!)
PORT=$B_PORT node dist/services/service-b/index.js >"$LOGDIR/b.log" 2>&1 & PIDS+=($!)
PORT=$GW_PORT HOST=127.0.0.1 \
  SERVICE_A_URL="http://127.0.0.1:$A_PORT" SERVICE_B_URL="http://127.0.0.1:$B_PORT" \
  RATE_LIMIT_CAPACITY=5 RATE_LIMIT_REFILL_PER_SEC=0.001 \
  node dist/src/server.js >"$LOGDIR/gw.log" 2>&1 & PIDS+=($!)

BASE="http://127.0.0.1:$GW_PORT"
fail() { echo "SMOKE FAIL: $1" >&2; echo "--- gateway log"; tail -20 "$LOGDIR/gw.log" >&2; exit 1; }

for _ in $(seq 1 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health/ready" || true)" = 200 ] && break
  sleep 0.5
done
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health/ready")" = 200 ] || fail "gateway never became ready"

TOKEN="$(node scripts/mint-token.mjs "smoke-$$")"
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

[ "$(code "$BASE/health/live")" = 200 ] || fail "liveness"
[ "$(code "$BASE/api/v1/service-a/ping")" = 401 ] || fail "missing token should be 401"
[ "$(code -H 'Authorization: Bearer abc.def.ghi' "$BASE/api/v1/service-a/ping")" = 401 ] || fail "bad token should be 401"

BODY="$(curl -s -D "$LOGDIR/headers" -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/service-a/ping")"
echo "$BODY" | grep -q '"service":"service-a"' || fail "request not routed to service-a: $BODY"
grep -qi '^ratelimit-limit: 5' "$LOGDIR/headers" || fail "rate-limit headers missing"
[ "$(code -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/service-b/ping")" = 200 ] || fail "service-b route"

# Quota is 5 per (user, service): 1 used above, so exactly 4 more then 429.
for _ in 1 2 3 4; do [ "$(code -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/service-a/ping")" = 200 ] || fail "within quota"; done
[ "$(code -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/service-a/ping")" = 429 ] || fail "6th request should be 429"

echo "smoke OK: compiled build routes, authenticates and rate-limits against Redis"
