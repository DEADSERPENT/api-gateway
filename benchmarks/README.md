# Benchmarks

Latest run: **`20261031-232346`** (5 trials per scenario). Full tables, CPU/memory and per-trial
data are in its `RESULTS.md`. Cells below are median (min-max).

    bash scripts/bench.sh                         # everything, 5 trials
    ONLY=baseline,failure TRIALS=5 bash scripts/bench.sh

## Method

- **Baseline:** each trial runs 10 s of warm-up and then 30 s measured, with the same virtual
  users and connections throughout. Requests are tagged `warmup` or `measured` as they are sent;
  every reported figure uses the measured phase only. Warm-up is kept as a separate cold-start
  record in `RESULTS.md`. Change it with `WARMUP_S` and `MEASURE_S`.
- **Failure and recovery:** service B is failed, then restored 15-18 s later. The 5 restore delays
  come from seed `20261101` (one in each fifth of the 3 s probe interval, shuffled), so the run is
  reproducible and covers different positions in the breaker's probe cycle. The restore time is the
  instant the mock service itself reports switching back. Recovery is the time from that instant
  to the first real `200`; an open-circuit `503` never counts. A trial is "confirmed" only if the
  breaker logged a CLOSED transition and no request failed after the first success.

## Results

| 100 virtual users, 30 s measured | Throughput | p99 | max |
|---|---:|---:|---:|
| 1 gateway | 1,922 req/s (1844-2033) | 81 ms | 100 ms (89-124) |
| 2 gateways | 2,371 req/s (2102-2536) | 104 ms | 141 ms (111-156) |

No request took over 500 ms in any measured phase (0 of 903,754), and none failed. The 20-VU
single-gateway run reached 1,708 req/s (1674-1852).

| Circuit breaker (cooldown 3 s, 20 req/s) | Result |
|---|---|
| Fault to breaker open | 251 ms (250-252) |
| Fast rejection latency while open | p99 2.7 ms |
| Recovery after the service is restored | **1,749 ms (655-2,997)**, 5 of 5 confirmed |

Recovery depends on where the restore lands in the probe cycle: it equals the time until the
next probe, `(last failed probe + cooldown) - restore`. The simple model predicted every trial to
within 50 ms (the request spacing), so recovery is bounded by the cooldown, as expected.

Rate-limit accuracy was not re-run: in run `20261031-225242`, 10 of 10 trials admitted 299-300
requests against a possible 300, with one gateway or two.

## What changed since the previous run (`20261031-225242`)

- Its 1.4 s-2.5 s maximum latencies were cold-start effects on the less-used gateway. With
  warm-up excluded, measured maxima are 89-156 ms. The cold-start spikes still appear in the
  warm-up record (up to 2.3 s in the two-gateway runs), so they are real, not hidden.
  This is a methodology change, **not a performance improvement**: throughput is the same
  within run-to-run variation (1,922 vs 2,018 req/s at 100 VUs, overlapping ranges).
- Its "recovery about 400 ms" was an artifact of always restoring at the same point in the
  probe cycle. Recovery is really 0.7-3.0 s.

## Limitations

- Everything runs on one laptop in one Docker VM, with unrelated containers also present.
- Two gateways gave about 23 % more throughput (ranges do not overlap), far below double. This
  does not show horizontal scaling, and I did not investigate why.
- Five trials show spread but are too few for confidence intervals.
- Five restore points sample the probe cycle coarsely; the recovery model is a fit to these
  points, not a proof.
- Mock upstreams do almost no work, and the breaker is per process.
- Older run folders are kept as history: `213804` (contains the stalled run, labelled `INVALID-`),
  `222806` and `225242` (before warm-up and randomised restore).
