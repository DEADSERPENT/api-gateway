import { describe, expect, it } from 'vitest';
import { phaseAt } from '../../load/lib/phase.js';
import { gatewayMax, measuredStats, warmupStats } from '../../scripts/lib/baseline-stats.mjs';

const trend = (o: Record<string, number>) => ({ avg: 0, min: 0, ...o });

describe('phaseAt (warm-up / measured boundary used inside the k6 scenario)', () => {
  it('is warm-up strictly before the warm-up ends, measured from that instant on', () => {
    expect(phaseAt(0, 10_000)).toBe('warmup');
    expect(phaseAt(9_999, 10_000)).toBe('warmup');
    expect(phaseAt(10_000, 10_000)).toBe('measured');
    expect(phaseAt(39_999, 10_000)).toBe('measured');
  });

  it('treats a zero-length warm-up as all measured', () => {
    expect(phaseAt(0, 0)).toBe('measured');
  });
});

/** A summary where the whole-run numbers are polluted by a slow warm-up. */
const polluted = {
  http_reqs: { count: 70_000, rate: 1_750 },
  http_req_duration: trend({ med: 60, 'p(95)': 300, 'p(99)': 900, max: 2_497 }),
  'http_req_failed': { passes: 12, fails: 69_988, value: 0 },
  'http_req_duration{phase:measured}': trend({ med: 40, 'p(95)': 80, 'p(99)': 99, max: 140 }),
  'http_req_duration{phase:warmup}': trend({ med: 90, 'p(95)': 700, 'p(99)': 1_800, max: 2_497 }),
  'http_reqs{phase:measured}': { count: 60_000, rate: 1_500 },
  'http_reqs{phase:warmup}': { count: 10_000, rate: 250 },
  'http_req_failed{phase:measured}': { passes: 0, fails: 60_000, value: 0 },
  'http_req_failed{phase:warmup}': { passes: 12, fails: 9_988, value: 0.0012 },
};

describe('measuredStats', () => {
  it('reports latency from the measured phase only', () => {
    const s = measuredStats(polluted, { measureSeconds: 30 });
    expect(s.source).toBe('measured');
    expect(s.max).toBe(140);
    expect(s.p99).toBe(99);
    expect(s.p95).toBe(80);
    expect(s.p50).toBe(40);
  });

  it('divides measured requests by the measured window, not the whole run', () => {
    const s = measuredStats(polluted, { measureSeconds: 30 });
    expect(s.requests).toBe(60_000);
    expect(s.throughput).toBe(2_000); // not 1_750 (whole run) and not k6's phase "rate"
  });

  it('counts failures from the measured phase only', () => {
    expect(measuredStats(polluted, { measureSeconds: 30 }).failed).toBe(0);
  });

  it('reports warm-up separately and never mixes it into measured figures', () => {
    const w = warmupStats(polluted);
    expect(w).not.toBeNull();
    expect(w?.requests).toBe(10_000);
    expect(w?.max).toBe(2_497);
    expect(w?.failed).toBe(12);
    expect(measuredStats(polluted, { measureSeconds: 30 }).max).not.toBe(w?.max);
  });

  it('is insensitive to the order of tags in a sub-metric key', () => {
    const m = {
      'http_req_duration{gw:gateway-2,phase:measured}': trend({ max: 77 }),
      'http_req_duration{phase:measured}': trend({ med: 1, 'p(95)': 2, 'p(99)': 3, max: 88 }),
      'http_reqs{phase:measured}': { count: 30, rate: 1 },
      'http_req_failed{phase:measured}': { passes: 0, fails: 30, value: 0 },
    };
    expect(measuredStats(m, { measureSeconds: 30 }).max).toBe(88);
    expect(gatewayMax(m)).toEqual({ 'gateway-2': 77 });
  });

  it('falls back to whole-run numbers, labelled as such, when there are no phase tags', () => {
    const legacy = {
      http_reqs: { count: 30_000, rate: 1_000 },
      http_req_duration: trend({ med: 50, 'p(95)': 90, 'p(99)': 120, max: 600 }),
      http_req_failed: { passes: 0, fails: 30_000, value: 0 },
    };
    const s = measuredStats(legacy, { measureSeconds: 30 });
    expect(s.source).toBe('whole-run');
    expect(s.throughput).toBe(1_000);
    expect(warmupStats(legacy)).toBeNull();
  });
});

describe('gatewayMax', () => {
  it('lists per-replica maxima for the measured phase only', () => {
    const m = {
      'http_req_duration{phase:measured,gw:gateway-1}': trend({ max: 101 }),
      'http_req_duration{phase:measured,gw:gateway-2}': trend({ max: 133 }),
      'http_req_duration{phase:warmup,gw:gateway-2}': trend({ max: 2_400 }),
    };
    expect(gatewayMax(m)).toEqual({ 'gateway-1': 101, 'gateway-2': 133 });
  });
});
