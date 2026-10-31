# Results (benchmarks/20261031-225242)

Each cell is **median (min-max)** across trials. Trials per configuration are shown as `n`.

## Proxy baseline (30 s closed-loop, quota not limiting)

| Configuration | n | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | failed |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline-1gw-100vu | 5 | 2018 (1760-2146) | 47.6 (44.6-54.7) | 62.9 (59.4-68.8) | 75.5 (70.2-77.6) | 600 (399-765) | 0 |
| baseline-1gw-20vu | 5 | 1858 (1446-2064) | 10.2 (9.1-12.6) | 14.5 (12.8-20.9) | 17.8 (15.7-28.4) | 36 (32-149) | 0 |
| baseline-2gw-100vu | 5 | 2401 (1486-2663) | 40.0 (36.3-57.9) | 83.2 (73.3-152.9) | 99.5 (92.2-189.3) | 1461 (635-2497) | 0 |

Max latency per replica in the two-gateway runs (ms, per trial):

- gateway-2: 2497, 1554, 635, 768, 1461
- gateway-1: 106, 120, 117, 110, 80

Requests slower than 500 ms across all baseline trials: **252**

| Trial | Replica | Total (ms) | Waiting (ms) | Connecting (ms) | At (s) |
|---|---|---:|---:|---:|---:|
| baseline-1gw-100vu.t1 | gateway-1 | 500 | 500 | 0 | 0.5 |
| baseline-1gw-100vu.t1 | gateway-1 | 509 | 508 | 32 | 0.5 |
| baseline-1gw-100vu.t1 | gateway-1 | 518 | 518 | 0 | 0.6 |
| baseline-1gw-100vu.t1 | gateway-1 | 528 | 528 | 32 | 0.6 |
| baseline-1gw-100vu.t1 | gateway-1 | 549 | 549 | 32 | 0.6 |
| baseline-1gw-100vu.t1 | gateway-1 | 558 | 557 | 32 | 0.6 |
| baseline-1gw-100vu.t1 | gateway-1 | 569 | 569 | 32 | 0.6 |
| baseline-1gw-100vu.t1 | gateway-1 | 581 | 581 | 32 | 0.6 |
| baseline-1gw-100vu.t1 | gateway-1 | 594 | 594 | 32 | 0.6 |
| baseline-1gw-100vu.t1 | gateway-1 | 615 | 615 | 0 | 0.7 |
| baseline-1gw-100vu.t1 | gateway-1 | 627 | 627 | 0 | 0.7 |
| baseline-1gw-100vu.t1 | gateway-1 | 643 | 642 | 0 | 0.7 |
| baseline-1gw-100vu.t1 | gateway-1 | 658 | 657 | 0 | 0.7 |
| baseline-1gw-100vu.t1 | gateway-1 | 666 | 666 | 0 | 0.7 |
| baseline-1gw-100vu.t1 | gateway-1 | 678 | 678 | 0 | 0.7 |
| baseline-1gw-100vu.t1 | gateway-1 | 693 | 692 | 0 | 0.7 |
| baseline-1gw-100vu.t1 | gateway-1 | 705 | 705 | 0 | 0.7 |
| baseline-1gw-100vu.t1 | gateway-1 | 727 | 727 | 0 | 0.8 |
| baseline-1gw-100vu.t1 | gateway-1 | 736 | 736 | 1 | 0.8 |
| baseline-1gw-100vu.t1 | gateway-1 | 752 | 752 | 0 | 0.8 |
| baseline-1gw-100vu.t1 | gateway-1 | 765 | 765 | 0 | 0.8 |
| baseline-1gw-100vu.t2 | gateway-1 | 504 | 504 | 0 | 0.5 |
| baseline-1gw-100vu.t2 | gateway-1 | 522 | 522 | 0 | 0.5 |
| baseline-1gw-100vu.t2 | gateway-1 | 532 | 532 | 0 | 0.6 |
| baseline-1gw-100vu.t2 | gateway-1 | 549 | 549 | 0 | 0.6 |
| ... | | | | | (227 more) |

## Rate-limit accuracy (capacity 100, refill 10/s, 100 req/s for 20 s; max possible 300)

| Configuration | n | Admitted (median, min-max) | Rejected | Other | Admitted per trial | p95 (ms) |
|---|---:|---:|---:|---:|---|---:|
| ratelimit-1gw | 5 | 299 (299-300) | 1702 (1701-1702) | 0 (0-0) | 299, 299, 299, 299, 300 | 2.39 (2.19-2.98) |
| ratelimit-2gw | 5 | 299 (299-300) | 1702 (1701-1702) | 0 (0-0) | 300, 299, 299, 299, 299 | 2.56 (2.38-2.63) |

## Downstream failure and recovery (5 trials; 20 req/s; breaker cooldown 3 s)

| Metric | median (min-max) | per trial |
|---|---:|---|
| Fault injected to breaker open (ms) | 250 (249-251) | 250, 249, 250, 251, 250 |
| Open-circuit latency p99 (ms) | 2.31 (2.23-2.92) | 2.55, 2.92, 2.31, 2.24, 2.23 |
| Fast 503 responses during failure | 292 (292-292) | 292, 292, 292, 292, 292 |
| Upstream 500s passed through | 9 (9-9) | 9, 9, 9, 9, 9 |
| First 200 after restore (ms) | 398 (250-399) | 399, 398, 250, 399, 299 |

## CPU and memory (docker stats, sampled about every 1-2 s during each run)

CPU is a percentage of one core (it can exceed 100). Per-trial values are first reduced to a mean and a peak, then summarised as median (min-max) across trials.

| Run | Container | mean CPU % | peak CPU % | peak memory (MiB) |
|---|---|---:|---:|---:|
| baseline-1gw-100vu | gateway-1 | 112 (110-115) | 137 (132-143) | 103 (93-109) |
| baseline-1gw-100vu | gateway-2 | 6 (5-10) | 28 (22-98) | 74 (45-95) |
| baseline-1gw-100vu | k6 (load generator) | 72 (71-126) | 81 (76-126) | 59 (47-63) |
| baseline-1gw-100vu | mock services | 8 (0-18) | 9 (0-21) | 24 (21-50) |
| baseline-1gw-100vu | redis | 14 (11-15) | 16 (13-17) | 4 (4-4) |
| baseline-1gw-20vu | gateway-1 | 116 (115-123) | 140 (136-159) | 93 (88-108) |
| baseline-1gw-20vu | gateway-2 | 5 (4-6) | 22 (21-26) | 74 (43-87) |
| baseline-1gw-20vu | k6 (load generator) | 77 (73-81) | 80 (73-83) | 39 (29-47) |
| baseline-1gw-20vu | mock services | 9 (0-20) | 10 (0-22) | 23 (21-50) |
| baseline-1gw-20vu | redis | 15 (12-17) | 18 (13-19) | 4 (4-4) |
| baseline-2gw-100vu | gateway-1 | 111 (108-116) | 143 (140-159) | 97 (93-108) |
| baseline-2gw-100vu | gateway-2 | 117 (105-126) | 184 (143-231) | 86 (80-91) |
| baseline-2gw-100vu | k6 (load generator) | 117 (80-121) | 126 (80-131) | 65 (21-72) |
| baseline-2gw-100vu | mock services | 16 (0-33) | 18 (0-42) | 28 (21-50) |
| baseline-2gw-100vu | redis | 22 (20-25) | 30 (23-32) | 4 (4-8) |
| failure | gateway-1 | 7 (6-8) | 20 (18-27) | 47 (40-56) |
| failure | gateway-2 | 3 (2-3) | 15 (14-17) | 40 (30-46) |
| failure | k6 (load generator) | 3 (2-3) | 3 (3-5) | 18 (14-19) |
| failure | mock services | 0 (0-1) | 1 (0-6) | 35 (21-49) |
| failure | redis | 2 (1-3) | 4 (3-7) | 4 (4-5) |
| ratelimit-1gw | gateway-1 | 17 (15-20) | 32 (27-52) | 50 (49-60) |
| ratelimit-1gw | gateway-2 | 3 (2-5) | 15 (14-34) | 42 (38-43) |
| ratelimit-1gw | k6 (load generator) | 9 (9-11) | 13 (11-17) | 25 (24-26) |
| ratelimit-1gw | mock services | 0 (0-1) | 1 (0-3) | 35 (21-49) |
| ratelimit-1gw | redis | 4 (2-6) | 6 (3-11) | 4 (4-5) |
| ratelimit-2gw | gateway-1 | 10 (9-13) | 26 (21-32) | 50 (49-51) |
| ratelimit-2gw | gateway-2 | 12 (11-13) | 26 (24-31) | 43 (37-60) |
| ratelimit-2gw | k6 (load generator) | 10 (9-17) | 12 (10-17) | 26 (20-27) |
| ratelimit-2gw | mock services | 0 (0-1) | 1 (0-3) | 35 (21-49) |
| ratelimit-2gw | redis | 4 (2-5) | 5 (3-6) | 4 (4-9) |

Discarded stalled attempts: 0
Trials per configuration: 5
