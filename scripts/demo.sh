#!/usr/bin/env bash
# Paced live demo for screen recording (about 4 minutes). Run from Git Bash:
#     bash scripts/demo.sh
# Each step prints a title and a suggested line to say, then waits for Enter, then runs real
# commands against the real stack. AUTO=1 skips the waiting (used to test the script).
# Before recording:  docker compose up -d --build   (once, so images are built)
cd "$(dirname "$0")/.."

GW1=127.0.0.1:3001
GW2=127.0.0.1:3002
SVC_B_ADMIN=127.0.0.1:4002

wait_key() { if [ "${AUTO:-0}" = 1 ]; then sleep 1; else read -r -p "   [Enter to run] " _; fi; }
step() { # step "title" "what to say"
  printf '\n\033[1;36m== %s\033[0m\n' "$1"
  [ -n "${2:-}" ] && printf '\033[33m   say: %s\033[0m\n' "$2"
  wait_key
}
show() { printf '\033[2m$ %s\033[0m\n' "$*"; eval "$@"; } # prints the command, then runs it
RUN_ID=$(date +%s) # users are unique per run, so re-takes never inherit a used-up quota
tok() { node scripts/mint-token.mjs "$1-$RUN_ID" 1h; }
codes() { # codes <gateway> <user> <service> <count> : status codes on one line
  local t; t=$(tok "$2")
  for _ in $(seq 1 "$4"); do
    curl -s -o /dev/null -w '%{http_code} ' -H "Authorization: Bearer $t" "$1/api/v1/$3/ping"
  done
  echo
}
wait_ready() { for _ in $(seq 1 40); do curl -sf "$1/health/ready" >/dev/null && return 0; sleep 0.5; done; }
setmode() { curl -s -X POST -H 'content-type: application/json' -d "{\"mode\":\"$1\"}" "$SVC_B_ADMIN/admin/mode" >/dev/null; }

[ -f .dev/gateway.env ] || node scripts/dev-keys.mjs >/dev/null
setmode ok

step "0. The stack" \
  "Two gateway replicas, Redis, and two mock services, all in Docker. Quota is 20 requests per user per service, refilling slowly."
docker compose exec -T redis redis-cli FLUSHALL >/dev/null 2>&1 # clean slate for every take
IP_RATE_LIMIT_CAPACITY=100 IP_RATE_LIMIT_REFILL_PER_SEC=1 \
  RATE_LIMIT_CAPACITY=20 RATE_LIMIT_REFILL_PER_SEC=0.05 RATE_LIMIT_FAIL_POLICY=closed \
  BREAKER_COOLDOWN_MS=3000 UPSTREAM_TIMEOUT_MS=1000 \
  docker compose up -d --force-recreate gateway-1 gateway-2 >/dev/null 2>&1
wait_ready $GW1; wait_ready $GW2
show "docker compose ps --format 'table {{.Name}}\t{{.State}}'"

step "1. Health checks" \
  "Liveness only says the process is up. Readiness also checks Redis, and neither exposes any internal detail."
show "curl -s $GW1/health/live; echo; curl -s $GW2/health/ready; echo"

step "2. A valid request" \
  "A signed RS256 token gets routed to service A. The gateway adds a request ID, the verified user, and rate-limit headers. The token itself is never forwarded."
T=$(tok alice)
show "curl -si -H \"Authorization: Bearer \$T\" $GW1/api/v1/service-a/ping | grep -iE '^HTTP|x-request-id|ratelimit|service|authenticatedUser|receivedAuthorization'"

step "3. Invalid credentials" \
  "No token, or a forged one, is rejected at the edge with 401 and a generic message. The upstream is never called."
show "curl -s -w ' [%{http_code}]\n' $GW1/api/v1/service-a/ping"
show "curl -s -w ' [%{http_code}]\n' -H 'Authorization: Bearer abc.def.ghi' $GW1/api/v1/service-a/ping"

step "4. Rate limiting" \
  "One user sends 24 requests. The first 20 pass, the rest get 429 with a Retry-After header."
show "codes $GW1 bob service-a 24"
T=$(tok bob)
show "curl -si -H \"Authorization: Bearer \$T\" $GW1/api/v1/service-a/ping | grep -iE '^HTTP|retry-after|ratelimit-remaining|code'"

step "5. One quota shared across two gateways" \
  "Same idea, but the requests alternate between two separate gateway containers. They share one bucket in Redis, so the total is still 20, not 40."
T=$(tok carol)
show "for i in \$(seq 1 24); do p=\$((3001 + i % 2)); curl -s -o /dev/null -w '%{http_code} ' -H \"Authorization: Bearer \$T\" 127.0.0.1:\$p/api/v1/service-a/ping; done; echo"

step "6. Redis goes down" \
  "The default policy is fail-closed: with no Redis the gateway refuses traffic rather than skip the quota. Readiness goes red, liveness stays green."
show "docker compose stop redis >/dev/null 2>&1; sleep 1"
T=$(tok dave)
show "curl -s -w ' [%{http_code}]\n' -H \"Authorization: Bearer \$T\" $GW1/api/v1/service-a/ping"
show "curl -s -o /dev/null -w 'ready=%{http_code}  ' $GW1/health/ready; curl -s -o /dev/null -w 'live=%{http_code}\n' $GW1/health/live"
say_back() { printf '\033[33m   say: Redis comes back and the gateway recovers on its own.\033[0m\n'; }
say_back
show "docker compose start redis >/dev/null 2>&1; sleep 4"
show "curl -s -o /dev/null -w 'request after recovery -> %{http_code}\n' -H \"Authorization: Bearer \$T\" $GW1/api/v1/service-a/ping"

step "7. Circuit breaker opens" \
  "Service B starts failing. After 5 failures the breaker opens, and the next requests are rejected in milliseconds without touching service B."
setmode fail
T=$(tok erin)
show "for i in \$(seq 1 9); do curl -s -o /dev/null -w '%{http_code} in %{time_total}s\n' -H \"Authorization: Bearer \$T\" $GW1/api/v1/service-b/ping; done"

step "8. Recovery" \
  "I restore service B. After the cooldown the breaker lets one probe through, it succeeds, and the circuit closes."
setmode ok
sleep 3.5
show "for i in 1 2 3; do curl -s -o /dev/null -w '%{http_code}\n' -H \"Authorization: Bearer \$T\" $GW1/api/v1/service-b/ping; done"

step "9. A flood of forged tokens" \
  "Someone with no login hammers the gateway with fake tokens. The per-IP limit is checked before the token is even verified, so after a burst they are cut off with 429."
show "for i in \$(seq 1 300); do curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer abc.def.ghi' $GW1/api/v1/service-a/ping; done | sort | uniq -c"

step "10. Metrics" \
  "Everything we just did is counted: rejections, breaker transitions, limiter errors."
show "curl -s $GW1/metrics | grep -E '^gateway_(rate_limit|ip_rate_limit|breaker|circuit|rate_limiter)' "

step "11. Measured results" \
  "The latest benchmark run: five trials each, warm-up excluded, on one laptop. These are measurements, not guarantees."
LATEST=$(ls -d benchmarks/2* 2>/dev/null | tail -1)
[ -n "$LATEST" ] && [ -f "$LATEST/RESULTS.md" ] && show "grep -E '^\| (Configuration|baseline-|Recovery after)' $LATEST/RESULTS.md"

step "Wrap-up" \
  "Auth, a Redis token bucket in one Lua script, circuit breakers and timeouts, tested across real containers. Limits: per-replica breakers, single Redis, mock upstreams."
setmode ok
echo "Done."
