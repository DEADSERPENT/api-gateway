# Results (benchmarks/20261031-232346)

Each cell is **median (min-max)** across trials.

Run config: 5 trials; baseline 10 s warm-up + 30 s measured; failure seed 20261101, restore delay 15000-18000 ms after the fault, breaker cooldown 3000 ms.

## Proxy baseline (measured phase only: 30 s after a 10 s warm-up; warm-up requests excluded)

| Configuration | n | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | failed |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline-1gw-100vu | 5 | 1922 (1844-2033) | 50.3 (46.9-51.4) | 70.3 (59.8-74.4) | 81.4 (66.2-92.3) | 100 (89-124) | 0 |
| baseline-1gw-20vu | 5 | 1708 (1674-1852) | 10.8 (10.1-11.1) | 16.7 (15.5-18.4) | 21.5 (19.5-26.7) | 41 (39-56) | 0 |
| baseline-2gw-100vu | 5 | 2371 (2102-2536) | 42.4 (39.4-48.0) | 81.9 (73.8-88.9) | 104.3 (90.7-106.3) | 141 (111-156) | 0 |

Measured-phase max latency per replica in the two-gateway runs (ms, per trial):

- gateway-2: 111, 136, 127, 156, 141
- gateway-1: 93, 89, 152, 113, 66

### Cold-start record (the 10 s warm-up phase, kept separate; not part of the figures above)

| Configuration | n | requests | p99 (ms) | max (ms) | failed |
|---|---:|---:|---:|---:|---:|
| baseline-1gw-100vu | 5 | 19008 (16536-19811) | 90.7 (72.1-119.9) | 572 (442-614) | 0 |
| baseline-1gw-20vu | 5 | 16764 (12857-19001) | 24.6 (18.2-27.3) | 49 (33-136) | 0 |
| baseline-2gw-100vu | 5 | 20922 (18083-27042) | 118.2 (91.2-190.1) | 1413 (660-2291) | 0 |

Requests over 500 ms: **0** in the measured phase, **248** during warm-up (gateway-1, gateway-2)

## Downstream failure and recovery (5 trials; 20 req/s; breaker cooldown 3000 ms)

Restore delays were drawn from a seeded, stratified schedule (one trial per slice of one probe cycle). Timestamps are the instants the mock service reported switching mode; recovery is measured from the restore to the first genuine `200` (an open-circuit `503` never counts).

| Trial | Planned restore delay (ms) | Actual (ms) | Restore to last failed probe (ms) | Recovery (ms) | Model prediction (ms) | Error (ms) | Open-circuit 503s before recovery | Breaker OPEN / HALF_OPEN / CLOSED | Confirmed |
|---:|---:|---:|---:|---:|---:|---:|---:|---|:---:|
| 1 | 16137 | 16138 | 686 | 2363 | 2314 | 49 | 47 | 6 / 6 / 1 | yes |
| 2 | 17694 | 17696 | 2394 | 655 | 606 | 49 | 13 | 6 / 6 / 1 | yes |
| 3 | 16651 | 16652 | 1251 | 1749 | 1749 | 0 | 34 | 6 / 6 / 1 | yes |
| 4 | 17051 | 17052 | 1701 | 1349 | 1299 | 50 | 26 | 6 / 6 / 1 | yes |
| 5 | 15404 | 15405 | 53 | 2997 | 2947 | 50 | 59 | 6 / 6 / 1 | yes |

| Summary | median (min-max) |
|---|---:|
| Recovery after restore (ms) | 1749 (655-2997) |
| Fault injected to breaker open (ms) | 251 (250-252) |
| Open-circuit latency p99 (ms) | 2.67 (2.47-3.73) |
| Fast open-circuit 503s during the failure | 324 (299-344) |
| Upstream 500s passed through | 10 (10-10) |
| Restore delay error: actual minus planned (ms) | 1 (1-2) |
| Model prediction error (ms) | 49 (0-50) |

Confirmed recoveries (breaker closed, first success after restore, no relapse): **5 of 5**. Service timestamp inside the client's send/ack window: **5 of 5**.

Correlation between the restore's position in the probe cycle and recovery time: Pearson r = **-1.000** (n = 5). Recovery spans 655-2997 ms, so it does vary with restore timing.

## CPU and memory (docker stats, sampled about every 1-2 s over the whole run, including warm-up)

CPU is a percentage of one core (it can exceed 100). Per-trial values are reduced to a mean and a peak, then summarised across trials.

| Run | Container | mean CPU % | peak CPU % | peak memory (MiB) |
|---|---|---:|---:|---:|
| baseline-1gw-100vu | gateway-1 | 113 (112-115) | 137 (133-141) | 107 (98-108) |
| baseline-1gw-100vu | gateway-2 | 6 (4-11) | 27 (22-122) | 43 (35-86) |
| baseline-1gw-100vu | k6 (load generator) | 77 (76-79) | 93 (81-133) | 66 (65-67) |
| baseline-1gw-100vu | redis | 11 (11-14) | 13 (11-17) | 4 (4-9) |
| baseline-1gw-100vu | service-a | 16 (16-17) | 18 (18-19) | 50 (29-50) |
| baseline-1gw-100vu | service-b | 0 (0-0) | 0 (0-0) | 21 (21-21) |
| baseline-1gw-20vu | gateway-1 | 115 (114-120) | 145 (139-148) | 92 (84-106) |
| baseline-1gw-20vu | gateway-2 | 5 (5-6) | 27 (24-41) | 76 (40-91) |
| baseline-1gw-20vu | k6 (load generator) | 80 (75-81) | 85 (82-87) | 47 (41-48) |
| baseline-1gw-20vu | redis | 16 (12-17) | 18 (18-20) | 4 (4-8) |
| baseline-1gw-20vu | service-a | 19 (19-19) | 21 (21-21) | 50 (29-50) |
| baseline-1gw-20vu | service-b | 0 (0-0) | 0 (0-0) | 21 (21-21) |
| baseline-2gw-100vu | gateway-1 | 112 (108-115) | 147 (146-150) | 103 (96-106) |
| baseline-2gw-100vu | gateway-2 | 115 (111-122) | 151 (149-206) | 84 (75-94) |
| baseline-2gw-100vu | k6 (load generator) | 125 (119-127) | 137 (135-139) | 72 (71-76) |
| baseline-2gw-100vu | redis | 25 (22-25) | 28 (28-30) | 4 (4-10) |
| baseline-2gw-100vu | service-a | 33 (31-33) | 38 (37-39) | 50 (36-51) |
| baseline-2gw-100vu | service-b | 0 (0-0) | 0 (0-0) | 21 (21-21) |
| failure | gateway-1 | 7 (7-9) | 23 (19-28) | 49 (40-52) |
| failure | gateway-2 | 3 (2-4) | 14 (14-20) | 43 (29-47) |
| failure | k6 (load generator) | 3 (2-3) | 4 (3-5) | 20 (19-21) |
| failure | redis | 3 (1-3) | 5 (3-7) | 4 (4-4) |
| failure | service-a | 0 (0-0) | 0 (0-0) | 50 (50-50) |
| failure | service-b | 1 (1-1) | 2 (1-3) | 21 (21-21) |

Discarded stalled attempts: 0
