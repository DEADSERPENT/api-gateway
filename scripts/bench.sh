#!/usr/bin/env bash
# Reproducible benchmark runner. Requires Docker.
#   scripts/bench.sh                   all experiments, TRIALS (default 5) each
#   TRIALS=3 ONLY=ratelimit scripts/bench.sh
# ONLY is a comma list of: baseline, ratelimit, failure.
# Raw k6 output, per-trial summaries, container CPU/memory samples and the environment are
# written to benchmarks/<timestamp>/, and RESULTS.md is generated from them.
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1

TRIALS="${TRIALS:-5}"
WARMUP_S="${WARMUP_S:-10}"             # baseline: warm-up before the measured window (same VUs)
MEASURE_S="${MEASURE_S:-30}"           # baseline: measured window, after the warm-up
SEED="${SEED:-20261101}"               # failure: seed for the randomised restore schedule
COOLDOWN_MS=3000                       # breaker cooldown the gateways are started with
RESTORE_MIN_MS="${RESTORE_MIN_MS:-15000}"  # failure: restore this long after the fault, plus
RESTORE_SPAN_MS="$COOLDOWN_MS"             # a stratified offset covering one full probe cycle
FAIL_AFTER_S=10
FAILURE_RATE=20
RUN="benchmarks/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUN"
WORK="$(pwd -W 2>/dev/null || pwd)"
NET="api-gateway_default"
K6_IMAGE="grafana/k6:1.0.0"

[ -f .dev/gateway.env ] || node scripts/dev-keys.mjs

want() { [ -z "${ONLY:-}" ] || [[ ",$ONLY," == *",$1,"* ]]; }
TOKEN_FOR() { node scripts/mint-token.mjs "$1" 2h; }
redis_flush() { docker exec "$(docker compose ps -q redis)" redis-cli FLUSHALL >/dev/null; }

up() { # up <capacity> <refill> : (re)start gateways with a given quota
  RATE_LIMIT_CAPACITY="$1" RATE_LIMIT_REFILL_PER_SEC="$2" BREAKER_COOLDOWN_MS="$COOLDOWN_MS" \
    docker compose up -d --force-recreate gateway-1 gateway-2 >/dev/null
  for _ in $(seq 1 60); do
    curl -sf 127.0.0.1:3001/health/ready >/dev/null && curl -sf 127.0.0.1:3002/health/ready >/dev/null && return 0
    sleep 1
  done
  echo "gateways did not become ready" >&2; exit 1
}

# A host/VM stall (e.g. sleep) mid-run corrupts time-based results such as refill counts,
# so flag any run whose wall time is far above the scheduled duration. Returns 1 if stalled.
check_duration() { # check_duration <name> <expected-seconds>
  local got secs
  got=$(grep -oE 'running \([0-9ms.]+\)' "$RUN/$1.txt" | tail -1 | sed -E 's/running \(//; s/\)//')
  secs=$(echo "$got" | awk '{ n = split($0, a, "m"); if (n == 2) { sub(/s/, "", a[2]); print a[1] * 60 + a[2] } else { sub(/s/, "", $0); print $0 + 0 } }')
  if [ -n "$secs" ] && awk "BEGIN{exit !($secs > $2 + 15)}"; then
    echo "WARNING: $1 took ${secs}s (expected ~$2s): host stalled, discarding" | tee -a "$RUN/log.txt" >&2
    return 1
  fi
}

sample_stats() { # sample_stats <file> : CPU%/memory of every container, until killed
  while true; do
    docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' >>"$1" 2>/dev/null || true
  done
}

k6run() { # k6run <name> <script> [k6 args...]
  local name="$1" script="$2" rc=0
  shift 2
  sample_stats "$RUN/$name.stats.txt" &
  local sampler=$!
  docker run --rm --network "$NET" -v "$WORK:/work" -w /work "$K6_IMAGE" run \
    --summary-export "/work/$RUN/$name.summary.json" "$@" "/work/load/$script" 2>&1 \
    | tee "$RUN/$name.txt" || rc=$?
  kill "$sampler" 2>/dev/null || true
  wait "$sampler" 2>/dev/null || true
  return "$rc"
}

trial() { # trial <name> <expected-seconds> <script> [k6 args...] : retries a stalled run
  local name="$1" expected="$2" attempt f
  shift 2
  for attempt in 1 2 3; do
    k6run "$name" "$@"
    if check_duration "$name" "$expected"; then return 0; fi
    for f in "$RUN/$name".*; do mv "$f" "$RUN/INVALID-stalled-a$attempt-$(basename "$f")"; done
  done
  echo "FAILED: $name stalled 3 times" | tee -a "$RUN/log.txt" >&2
}

docker compose up -d redis service-a service-b >/dev/null

{
  echo "date: $(date -u +%FT%TZ)"
  echo "trials_per_configuration: $TRIALS"
  echo "os: $(cmd.exe /c ver 2>/dev/null | tr -d '\r' | tail -1)"
  echo "cpu: $(powershell.exe -NoProfile -Command '(Get-CimInstance Win32_Processor).Name' | tr -d '\r')"
  echo "host_ram_gb: $(powershell.exe -NoProfile -Command '[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB,1)' | tr -d '\r')"
  echo "docker: $(docker version --format '{{.Server.Version}}')"
  echo "docker_vm_cpus_mem: $(docker info --format '{{.NCPU}} CPUs, {{.MemTotal}} bytes')"
  echo "gateway_image_node: $(docker compose run --rm --no-deps --entrypoint node gateway-1 --version | tr -d '\r') (compiled dist/, multi-stage image)"
  echo "redis: $(docker compose exec -T redis redis-server --version)"
  echo "k6_image: $K6_IMAGE"
  echo "gateway_commit: $(git rev-parse --short HEAD 2>/dev/null || echo 'not a git repo') (uncommitted changes: $(git status --porcelain -- . 2>/dev/null | wc -l | tr -d ' '))"
} >"$RUN/environment.txt"

cat >"$RUN/run-config.json" <<EOF
{
  "trials": $TRIALS,
  "baseline": { "warmup_s": $WARMUP_S, "measure_s": $MEASURE_S },
  "failure": {
    "seed": $SEED,
    "rate_rps": $FAILURE_RATE,
    "fail_after_s": $FAIL_AFTER_S,
    "restore_delay_min_ms": $RESTORE_MIN_MS,
    "restore_delay_span_ms": $RESTORE_SPAN_MS,
    "breaker_cooldown_ms": $COOLDOWN_MS
  }
}
EOF

if want baseline; then
  echo "=== Baseline: healthy upstream, quota not limiting ($TRIALS trials, ${WARMUP_S}s warm-up + ${MEASURE_S}s measured)" | tee -a "$RUN/log.txt"
  up 1000000 1000000
  for t in $(seq 1 "$TRIALS"); do
    redis_flush
    trial "baseline-1gw-20vu.t$t" $((WARMUP_S + MEASURE_S)) baseline.js -e "TOKEN=$(TOKEN_FOR b20-$t)" -e VUS=20 \
      -e WARMUP_S="$WARMUP_S" -e MEASURE_S="$MEASURE_S" -e GATEWAYS=http://gateway-1:3000
    trial "baseline-1gw-100vu.t$t" $((WARMUP_S + MEASURE_S)) baseline.js -e "TOKEN=$(TOKEN_FOR b100-$t)" -e VUS=100 \
      -e WARMUP_S="$WARMUP_S" -e MEASURE_S="$MEASURE_S" -e GATEWAYS=http://gateway-1:3000
    trial "baseline-2gw-100vu.t$t" $((WARMUP_S + MEASURE_S)) baseline.js -e "TOKEN=$(TOKEN_FOR b2g-$t)" -e VUS=100 \
      -e WARMUP_S="$WARMUP_S" -e MEASURE_S="$MEASURE_S" -e GATEWAYS=http://gateway-1:3000,http://gateway-2:3000
  done
fi

if want ratelimit; then
  echo "=== Rate-limit accuracy: capacity 100, refill 10/s, 100 req/s for 20s ($TRIALS trials)" | tee -a "$RUN/log.txt"
  up 100 10
  for t in $(seq 1 "$TRIALS"); do
    redis_flush
    trial "ratelimit-1gw.t$t" 20 rate-limit.js -e "TOKEN=$(TOKEN_FOR rl1-$t)" -e RATE=100 -e DURATION=20s \
      -e GATEWAYS=http://gateway-1:3000
    redis_flush
    trial "ratelimit-2gw.t$t" 20 rate-limit.js -e "TOKEN=$(TOKEN_FOR rl2-$t)" -e RATE=100 -e DURATION=20s \
      -e GATEWAYS=http://gateway-1:3000,http://gateway-2:3000
  done
fi

if want failure; then
  echo "=== Downstream failure and recovery ($TRIALS trials, cooldown ${COOLDOWN_MS}ms, seed $SEED)" | tee -a "$RUN/log.txt"
  up 1000000 1000000
  # Restore delays after the fault: stratified over one probe cycle and shuffled, from SEED.
  mapfile -t DELAYS < <(node scripts/restore-schedule.mjs "$SEED" "$TRIALS" "$RESTORE_MIN_MS" "$RESTORE_SPAN_MS")
  echo "restore delays (ms after fault): ${DELAYS[*]}" | tee -a "$RUN/log.txt"
  for t in $(seq 1 "$TRIALS"); do
    delay="${DELAYS[$((t - 1))]}"
    name="failure.t$t"
    printf '{"seed":%s,"trial":%s,"planned_restore_delay_ms":%s,"cooldown_ms":%s,"arrival_interval_ms":%s}\n' \
      "$SEED" "$t" "$delay" "$COOLDOWN_MS" $((1000 / FAILURE_RATE)) >"$RUN/$name.plan.json"
    curl -sf -X POST -H 'content-type: application/json' -d '{"mode":"ok"}' 127.0.0.1:4002/admin/mode >/dev/null
    redis_flush
    curl -s 127.0.0.1:3001/metrics | node scripts/breaker-counts.mjs >"$RUN/$name.breaker-before.json"
    trial "$name" 40 downstream-failure.js --out "json=/work/$RUN/$name.ndjson" -e "TOKEN=$(TOKEN_FOR fail-$t)" \
      -e FAIL_AFTER_S="$FAIL_AFTER_S" -e FAIL_FOR_MS="$delay" -e RATE="$FAILURE_RATE"
    curl -s 127.0.0.1:3001/metrics | node scripts/breaker-counts.mjs >"$RUN/$name.breaker-after.json"
    [ -f "$RUN/$name.ndjson" ] && node scripts/analyze-failure.mjs "$RUN/$name.ndjson" "$RUN/$name.plan.json" \
      "$RUN/$name.breaker-before.json" "$RUN/$name.breaker-after.json" >"$RUN/$name.analysis.json"
  done
fi

node scripts/aggregate-bench.mjs "$RUN" | tee "$RUN/RESULTS.md"
echo "Raw results in $RUN"
