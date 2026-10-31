import { describe, expect, it } from 'vitest';
import { analyzeFailure } from '../../scripts/lib/failure-analysis.mjs';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const line = (metric: string, atMs: number, value: number, tags: Record<string, string> = {}) =>
  JSON.stringify({ type: 'Point', metric, data: { time: iso(atMs), value, tags } });

/** A request that finished at `endMs` (k6 stamps the sample when the request completes). */
const req = (endMs: number, outcome: string, status: number, durMs = 3) =>
  line('req_ms', endMs, durMs, { outcome, status: String(status), scenario: 'traffic' });
const ok = (endMs: number) => req(endMs, 'ok', 200, 5);
const open = (endMs: number, durMs = 3) => req(endMs, 'circuit_open', 503, durMs);
const bad = (endMs: number) => req(endMs, 'upstream_500', 500, 4);

const FAULT = 1_000;
const RESTORE = 16_000;
const events = (opts: { fault?: number; restore?: number; clientSkewMs?: number } = {}) => {
  const f = opts.fault ?? FAULT;
  const r = opts.restore ?? RESTORE;
  const skew = opts.clientSkewMs ?? 0;
  return [
    line('fault_at_ms', f + skew, T0 + f, { event: 'fail' }),
    line('restore_at_ms', r + skew, T0 + r, { event: 'restore' }),
    line('chaos_event', f - 5, 1, { event: 'fail_sent' }),
    line('chaos_event', f + 4, 1, { event: 'fail_ack' }),
    line('chaos_event', r - 5, 1, { event: 'restore_sent' }),
    line('chaos_event', r + 4, 1, { event: 'restore_ack' }),
  ];
};

/** Realistic trace: 5 failures open the breaker, a failed probe every 3 s, restore at 16 s. */
const trace = (extra: string[] = []) => [
  ...events(),
  ok(100), ok(600),
  bad(1_100), bad(1_150), bad(1_200), bad(1_240), bad(1_250), // opens at ~1250
  open(1_300), open(1_350), open(2_000), open(3_900),
  bad(4_260), open(4_300), // probe at 4.26 s fails -> reopened
  bad(7_270), bad(10_280), bad(13_290), // failed probes every ~3 s
  open(15_000), open(15_900),
  open(16_050), open(16_150), open(16_250), // restored at 16.0 s but still open
  ok(16_320), ok(16_370), ok(16_420),
  ...extra,
];

const analyze = (lines: string[], over: Record<string, unknown> = {}) =>
  analyzeFailure(lines, {
    plannedRestoreDelayMs: RESTORE - FAULT,
    cooldownMs: 3_000,
    arrivalIntervalMs: 50,
    transitions: { OPEN: 5, HALF_OPEN: 4, CLOSED: 1 },
    ...over,
  });

describe('analyzeFailure', () => {
  it('measures recovery from the service-reported restore to the first real success', () => {
    const a = analyze(trace());
    expect(a.timestamps.restore_at_ms).toBe(T0 + RESTORE);
    expect(a.recovery.recovered).toBe(true);
    expect(a.recovery.recovery_ms).toBe(320); // first ok ended at 16_320
    expect(a.timestamps.first_ok_after_restore_at_ms).toBe(T0 + 16_320);
  });

  it('does not treat an open-circuit 503 after the restore as a recovery', () => {
    const a = analyze(trace());
    expect(a.recovery.circuit_open_rejections_after_restore).toBe(3);
    expect(a.recovery.recovery_ms).toBeGreaterThan(250); // not 50, the first post-restore reply
  });

  it('reports no recovery when only open-circuit responses follow the restore', () => {
    const lines = [...events(), bad(1_100), open(1_300), open(16_100), open(16_200), open(20_000)];
    const a = analyze(lines);
    expect(a.recovery.recovered).toBe(false);
    expect(a.recovery.recovery_ms).toBeNull();
    expect(a.recovery_confirmed).toBe(false);
  });

  it('ignores a success that finished before the restore', () => {
    const a = analyze(trace([ok(15_900)]));
    expect(a.recovery.recovery_ms).toBe(320);
  });

  it('detects a relapse after the first success', () => {
    const a = analyze(trace([open(16_500), ok(16_600)]));
    expect(a.recovery.recovered).toBe(true);
    expect(a.recovery.stayed_recovered).toBe(false);
    expect(a.recovery_confirmed).toBe(false);
  });

  it('confirms recovery only with a CLOSED transition and a stable run of successes', () => {
    expect(analyze(trace()).recovery_confirmed).toBe(true);
    expect(analyze(trace(), { transitions: { OPEN: 5, HALF_OPEN: 4, CLOSED: 0 } }).recovery_confirmed).toBe(false);
  });

  it('uses the service-reported timestamp, not the client clock', () => {
    // The client records the events 40 ms late; the service-reported time must win.
    const lines = trace().filter((l) => !l.includes('restore_at_ms'));
    lines.push(line('restore_at_ms', RESTORE + 40, T0 + RESTORE, { event: 'restore' }));
    const a = analyze(lines);
    expect(a.timestamps.restore_at_ms).toBe(T0 + RESTORE);
    expect(a.recovery.recovery_ms).toBe(320);
  });

  it('checks the service timestamp falls inside the client send/ack window', () => {
    expect(analyze(trace()).timestamps.restore_within_client_window).toBe(true);
    const skewed = trace().filter((l) => !l.includes('restore_at_ms'));
    skewed.push(line('restore_at_ms', RESTORE, T0 + RESTORE + 500, { event: 'restore' }));
    expect(analyze(skewed).timestamps.restore_within_client_window).toBe(false);
  });

  it('records planned versus actual restore delay', () => {
    const a = analyze(trace(), { plannedRestoreDelayMs: 15_010 });
    expect(a.timestamps.actual_restore_delay_ms).toBe(15_000);
    expect(a.timestamps.restore_delay_error_ms).toBe(-10);
  });

  it('computes open-circuit latency only from circuit_open outcomes during the failure', () => {
    const a = analyze(trace([req(8_000, 'other', 503, 900)]));
    expect(a.during_failure.open_circuit_latency_ms.p99).toBeLessThan(10);
    expect(a.during_failure.other).toBe(1);
  });

  it('keeps the existing counts: upstream failures and fast 503s during the failure', () => {
    const a = analyze(trace());
    expect(a.during_failure.upstream_500).toBe(9); // 5 opening + 4 failed probes
    expect(a.during_failure.circuit_open).toBe(7); // the 3 after the restore are counted separately
    expect(a.time_to_open_ms).toBe(300); // first open at 1_300, fault at 1_000
  });

  it('relates recovery to the phase of the restore within the probe cycle', () => {
    const early = analyze(trace(), {}); // last failed probe 13.29 s; restore 2.71 s later
    expect(early.recovery.phase_since_last_failed_probe_ms).toBe(RESTORE - 13_290);
    expect(early.recovery.predicted_recovery_ms).toBe(13_290 + 3_000 - RESTORE); // 290
    expect(Math.abs(early.recovery.prediction_error_ms as number)).toBeLessThanOrEqual(50);

    // Same trace shape with the restore 2 s earlier: the next probe is further away.
    const lines = [
      ...events({ restore: 14_000 }),
      bad(1_100), open(1_300), bad(4_260), bad(7_270), bad(10_280), bad(13_290),
      open(14_100), open(15_000), open(16_000),
      ok(16_320), ok(16_370),
    ];
    const late = analyze(lines, { plannedRestoreDelayMs: 13_000 });
    expect(late.recovery.recovery_ms).toBe(2_320);
    expect(late.recovery.predicted_recovery_ms).toBe(2_290);
  });

  it('rejects traces missing the fault or restore timestamps', () => {
    expect(() => analyze([ok(100)])).toThrow(/fault_at_ms/);
    expect(() => analyze([line('fault_at_ms', 1, T0 + 1, { event: 'fail' })])).toThrow(/restore_at_ms/);
  });
});
