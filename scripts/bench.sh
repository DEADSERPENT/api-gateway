#!/usr/bin/env bash
# Reproducible benchmark runner. Requires Docker. Usage: scripts/bench.sh
# Raw k6 output and the environment description are written to benchmarks/<timestamp>/.
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1

RUN="benchmarks/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUN"
WORK="$(pwd -W 2>/dev/null || pwd)"
NET="api-gateway_default"
K6_IMAGE="grafana/k6:1.0.0"

[ -f .dev/gateway.env ] || node scripts/dev-keys.mjs

up() { # up <capacity> <refill> : (re)start gateways with a given quota
  RATE_LIMIT_CAPACITY="$1" RATE_LIMIT_REFILL_PER_SEC="$2" BREAKER_COOLDOWN_MS=3000 \
    docker compose up -d --force-recreate gateway-1 gateway-2 >/dev/null
  for _ in $(seq 1 60); do
    curl -sf 127.0.0.1:3001/health/ready >/dev/null && curl -sf 127.0.0.1:3002/health/ready >/dev/null && return 0
    sleep 1
  done
  echo "gateways did not become ready" >&2; exit 1
}

# ONLY=baseline,ratelimit,failure limits which experiments run (default: all).
want() { [ -z "${ONLY:-}" ] || [[ ",$ONLY," == *",$1,"* ]]; }

# A host/VM stall (e.g. sleep) mid-run corrupts time-based results such as refill counts,
# so flag any run whose wall time is far above the scheduled duration.
check_duration() { # check_duration <name> <expected-seconds>
  local got secs
  got=$(grep -oE 'running \([0-9ms.]+\)' "$RUN/$1.txt" | tail -1 | sed -E 's/running \(//; s/\)//')
  secs=$(echo "$got" | awk '{ n = split($0, a, "m"); if (n == 2) { sub(/s/, "", a[2]); print a[1] * 60 + a[2] } else { sub(/s/, "", $0); print $0 + 0 } }')
  if [ -n "$secs" ] && awk "BEGIN{exit !($secs > $2 + 15)}"; then
    echo "WARNING: $1 took ${secs}s (expected ~$2s): host stalled, DISCARD this result and rerun" | tee -a "$RUN/log.txt" >&2
  fi
}

k6run() { # k6run <name> <script> [k6 args...]  (env passed through with -e flags by caller)
  local name="$1" script="$2"; shift 2
  docker run --rm --network "$NET" -v "$WORK:/work" -w /work "$K6_IMAGE" run \
    --summary-export "/work/$RUN/$name.summary.json" "$@" "/work/load/$script" | tee "$RUN/$name.txt"
}

docker compose up -d redis service-a service-b >/dev/null

{
  echo "date: $(date -u +%FT%TZ)"
  echo "os: $(cmd.exe /c ver 2>/dev/null | tr -d '\r' | tail -1)"
  echo "cpu: $(powershell.exe -NoProfile -Command '(Get-CimInstance Win32_Processor).Name' | tr -d '\r')"
  echo "host_ram_gb: $(powershell.exe -NoProfile -Command '[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB,1)' | tr -d '\r')"
  echo "docker: $(docker version --format '{{.Server.Version}}')"
  echo "docker_vm_cpus_mem: $(docker info --format '{{.NCPU}} CPUs, {{.MemTotal}} bytes')"
  echo "node_in_image: $(docker compose run --rm --no-deps --entrypoint node gateway-1 --version | tr -d '\r')"
  echo "redis: $(docker compose exec -T redis redis-server --version)"
  echo "k6_image: $K6_IMAGE"
  echo "gateway_commit_or_tree: $(git rev-parse --short HEAD 2>/dev/null || echo 'not a git repo')"
} > "$RUN/environment.txt"

TOKEN_FOR() { node scripts/mint-token.mjs "$1" 2h; }

if want baseline; then
echo "=== 1. Baseline: one gateway, healthy upstream, quota not limiting" | tee "$RUN/log.txt"
up 1000000 1000000
for vus in 20 100; do
  docker exec "$(docker compose ps -q redis)" redis-cli FLUSHALL >/dev/null
  k6run "baseline-1gw-${vus}vu" baseline.js -e "TOKEN=$(TOKEN_FOR bench-$vus)" -e VUS=$vus -e DURATION=30s \
    -e GATEWAYS=http://gateway-1:3000
done

echo "=== 2. Baseline: two gateways, 100 VUs" | tee -a "$RUN/log.txt"
k6run "baseline-2gw-100vu" baseline.js -e "TOKEN=$(TOKEN_FOR bench-2gw)" -e VUS=100 -e DURATION=30s \
  -e GATEWAYS=http://gateway-1:3000,http://gateway-2:3000
fi

if want ratelimit; then
echo "=== 3. Rate-limit accuracy: capacity 100, refill 10/s, 100 req/s for 20s" | tee -a "$RUN/log.txt"
up 100 10
for gws in "http://gateway-1:3000" "http://gateway-1:3000,http://gateway-2:3000"; do
  n=$(echo "$gws" | tr ',' '\n' | wc -l | tr -d ' ')
  docker exec "$(docker compose ps -q redis)" redis-cli FLUSHALL >/dev/null
  k6run "ratelimit-${n}gw" rate-limit.js -e "TOKEN=$(TOKEN_FOR rl-$n)" -e RATE=100 -e DURATION=20s -e "GATEWAYS=$gws"
  check_duration "ratelimit-${n}gw" 20
done
fi

if want failure; then
echo "=== 4. Downstream failure and recovery (breaker cooldown 3s)" | tee -a "$RUN/log.txt"
up 1000000 1000000
docker run --rm --network "$NET" -v "$WORK:/work" -w /work "$K6_IMAGE" run \
  --out "json=/work/$RUN/failure.ndjson" -e "TOKEN=$(TOKEN_FOR bench-fail)" /work/load/downstream-failure.js \
  | tee "$RUN/failure.txt"
node scripts/analyze-failure.mjs "$RUN/failure.ndjson" | tee "$RUN/failure.analysis.json"
check_duration failure 40
fi

echo "Raw results in $RUN"
