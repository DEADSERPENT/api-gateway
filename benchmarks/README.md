# Benchmark report

Reproduce: `docker compose up -d` is handled by the script; run `bash scripts/bench.sh`
(`ONLY=baseline|ratelimit|failure` runs one experiment). Raw k6 output, summaries and the
environment description are stored per run in `benchmarks/<timestamp>/`.

## Environment (run `20261031-213804`, except where noted)

| | |
|---|---|
| Host | AMD Ryzen 7 6800HS, 39.2 GB RAM, Windows 11 (10.0.26300) |
| Docker | Desktop 29.7.2, Linux VM with 16 CPUs / 19.2 GiB |
| Gateway / mocks | Node v22.23.4 (Fastify 5.12.7), run through `tsx` (not a compiled build) |
| Redis | 7.4.12 |
| Load generator | k6 (`grafana/k6:1.0.0`) in a container on the same Docker network |
| Topology | **Everything shares one machine**: k6, 1-2 gateways, Redis, both mock services |

## Results

### 1. Proxy baseline (healthy upstream, quota set high enough never to reject)

Closed-loop load, 30 s each, one run each, 0 failed requests in all three.

| Setup | Throughput | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|
| 1 gateway, 20 VUs | 1,364 req/s | 13.3 ms | 22.6 ms | 32.3 ms | 188 ms |
| 1 gateway, 100 VUs | 1,670 req/s | 55.8 ms | 81.1 ms | 102 ms | 644 ms |
| 2 gateways, 100 VUs | 1,923 req/s | 56.0 ms | 111.6 ms | 141 ms | 2.15 s |

Reading these numbers: with a closed loop, latency at 100 VUs is mostly queueing, so it is
not comparable with the 20-VU row. Going from 1 to 2 gateways raised throughput only about
15 % while p95/p99 got worse. The load generator, Redis, the mock services and both
gateways compete for the same CPUs, so **this does not show horizontal scaling**, and the
second replica's tail latency (2.15 s max) is unexplained. I did not profile it.

### 2. Rate-limit accuracy (run `20261031-222806`)

One identity, constant 100 req/s for 20 s (2,001 requests), bucket capacity 100, refill
10 tokens/s. A correct limiter can admit at most `100 + 10 x 20 = 300`.

| Setup | Admitted | Rejected (429) | Other | p95 latency |
|---|---:|---:|---:|---:|
| 1 gateway | 299 | 1,702 | 0 | 3.2 ms |
| 2 gateways, requests alternating | 300 | 1,701 | 0 | 3.0 ms |

Both runs land on the theoretical bound, and the second gateway did not add quota. The
integration suite adds a tighter check: 500 simultaneous requests on one key admit exactly
50 (capacity 50), including across two separate Redis connections.

### 3. Downstream failure and recovery (`20261031-213804`)

20 req/s to service-b for 40 s. k6 injects a failure at t = 10 s and restores service-b
15 s later, and stamps both events itself so all times share one clock. Breaker: 5 failures
in 10 s opens it, cooldown 3 s, one probe.

| Metric | Result |
|---|---|
| Before failure | 200 requests, 100 % OK |
| Fault injected -> breaker open | 249 ms |
| During failure | 301 requests: 292 fast `503 CIRCUIT_OPEN`, 9 upstream `500`s |
| Open-circuit latency | p50 2.6 ms, p95 3.4 ms, p99 4.1 ms |
| First `200` after restore | 395 ms |
| After first `200` | 100 % OK |

The 9 upstream 500s are the 5 failures that opened the breaker plus 4 failed half-open
probes (one per 3 s cooldown over 15 s). **Recovery time is a single sample.** It is
bounded by the cooldown plus one probe, so it can be anywhere from near 0 to about 3 s
depending on where the restore lands in the cooldown cycle; 395 ms is one draw, not a typical
value.

### 4. Redis outage (manual, not part of `bench.sh`)

Checked once against the real Compose stack by stopping and starting the Redis container:

- `fail-closed`: all requests got `503 RATE_LIMITER_UNAVAILABLE`, `/health/ready` returned
  503, `/health/live` stayed 200. Both gateways were serving normally about 2 s after Redis
  came back.
- `fail-open`: all 25 requests against a quota of 10 were admitted (quota bypassed), each
  counted in `gateway_rate_limiter_errors_total{policy="open"}`, and readiness reported 503.

No latency or throughput was measured for outages.

## Invalid run (kept, not used)

The first full run's 1-gateway rate-limit scenario reported a duration of 45 min 58 s instead
of 20 s: the host or Docker VM stalled mid-run. Redis kept refilling the bucket during the
stall, so it admitted 400 (capacity 100 extra). It is saved as
`20261031-213804/INVALID-stalled-ratelimit-1gw.*` and was rerun. `bench.sh` now prints a
warning when a scenario's wall time is far above its scheduled duration.

## Limitations

- One run per configuration; no repetitions, so no confidence intervals or variance.
- CPU and memory per process were **not** captured, although the SDLC lists them.
- Laptop, single machine, shared CPUs, Docker Desktop networking; absolute numbers will not
  transfer to other hardware.
- The gateway runs through `tsx`, not a compiled build, and a mock upstream does almost no
  work, so these figures bound the gateway overhead, not a real service.
- The `/metrics` and rate-limit paths were not load-tested with many distinct identities;
  all tests above use one identity per scenario.
- The breaker is per process, so with two gateways each replica opens independently.
