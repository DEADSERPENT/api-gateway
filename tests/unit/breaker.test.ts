import { describe, expect, it } from 'vitest';
import { CircuitBreaker, type BreakerState } from '../../src/circuit-breaker/breaker.js';

function setup(overrides: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {}) {
  let now = 0;
  const transitions: Array<[BreakerState, BreakerState]> = [];
  const breaker = new CircuitBreaker({
    failureThreshold: 3,
    windowMs: 10_000,
    cooldownMs: 5_000,
    halfOpenMaxProbes: 1,
    now: () => now,
    onTransition: (from, to) => transitions.push([from, to]),
    ...overrides,
  });
  return {
    breaker,
    transitions,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function fail(b: CircuitBreaker, n = 1) {
  for (let i = 0; i < n; i++) b.tryAcquire()!.failure();
}

describe('CircuitBreaker', () => {
  it('starts CLOSED and admits requests', () => {
    const { breaker } = setup();
    expect(breaker.state).toBe('CLOSED');
    expect(breaker.tryAcquire()).not.toBeNull();
  });

  it('opens at exactly the failure threshold, not before', () => {
    const { breaker, transitions } = setup();
    fail(breaker, 2);
    expect(breaker.state).toBe('CLOSED');
    fail(breaker, 1);
    expect(breaker.state).toBe('OPEN');
    expect(transitions).toEqual([['CLOSED', 'OPEN']]);
  });

  it('failures outside the rolling window do not count', () => {
    const { breaker, advance } = setup();
    fail(breaker, 2);
    advance(10_001);
    fail(breaker, 1);
    expect(breaker.state).toBe('CLOSED');
  });

  it('successes do not hide failures inside the window', () => {
    const { breaker } = setup();
    fail(breaker, 2);
    breaker.tryAcquire()!.success();
    fail(breaker, 1);
    expect(breaker.state).toBe('OPEN');
  });

  it('fails fast while OPEN and reports time until retry', () => {
    const { breaker, advance } = setup();
    fail(breaker, 3);
    expect(breaker.tryAcquire()).toBeNull();
    advance(2_000);
    expect(breaker.tryAcquire()).toBeNull();
    expect(breaker.retryAfterMs()).toBe(3_000);
  });

  it('admits exactly one probe after cooldown (HALF_OPEN)', () => {
    const { breaker, advance } = setup();
    fail(breaker, 3);
    advance(5_000);
    const probe = breaker.tryAcquire();
    expect(probe).not.toBeNull();
    expect(breaker.state).toBe('HALF_OPEN');
    expect(breaker.tryAcquire()).toBeNull();
  });

  it('probe success closes the breaker and clears old failures', () => {
    const { breaker, advance, transitions } = setup();
    fail(breaker, 3);
    advance(5_000);
    breaker.tryAcquire()!.success();
    expect(breaker.state).toBe('CLOSED');
    fail(breaker, 2);
    expect(breaker.state).toBe('CLOSED');
    expect(transitions).toEqual([
      ['CLOSED', 'OPEN'],
      ['OPEN', 'HALF_OPEN'],
      ['HALF_OPEN', 'CLOSED'],
    ]);
  });

  it('probe failure reopens and restarts the cooldown', () => {
    const { breaker, advance } = setup();
    fail(breaker, 3);
    advance(5_000);
    breaker.tryAcquire()!.failure();
    expect(breaker.state).toBe('OPEN');
    advance(4_999);
    expect(breaker.tryAcquire()).toBeNull();
    advance(1);
    expect(breaker.tryAcquire()).not.toBeNull();
  });

  it('releases the probe permit when a request is abandoned (ignore)', () => {
    const { breaker, advance } = setup();
    fail(breaker, 3);
    advance(5_000);
    breaker.tryAcquire()!.ignore();
    expect(breaker.state).toBe('HALF_OPEN');
    expect(breaker.tryAcquire()).not.toBeNull();
  });

  it('a ticket settles only once', () => {
    const { breaker } = setup();
    const t = breaker.tryAcquire()!;
    t.failure();
    t.failure();
    t.failure();
    expect(breaker.state).toBe('CLOSED');
  });

  it('late outcomes from before a transition are ignored', () => {
    const { breaker, advance } = setup({ failureThreshold: 1 });
    const slow = breaker.tryAcquire()!; // admitted while CLOSED
    fail(breaker, 1); // opens
    advance(5_000);
    const probe = breaker.tryAcquire()!;
    slow.success(); // stale success must not close the breaker
    expect(breaker.state).toBe('HALF_OPEN');
    probe.success();
    expect(breaker.state).toBe('CLOSED');
  });

  it('supports a configurable number of half-open probes', () => {
    const { breaker, advance } = setup({ halfOpenMaxProbes: 2 });
    fail(breaker, 3);
    advance(5_000);
    expect(breaker.tryAcquire()).not.toBeNull();
    expect(breaker.tryAcquire()).not.toBeNull();
    expect(breaker.tryAcquire()).toBeNull();
  });

  it('rejects invalid configuration', () => {
    expect(() => setup({ failureThreshold: 0 })).toThrow();
    expect(() => setup({ cooldownMs: -1 })).toThrow();
    expect(() => setup({ halfOpenMaxProbes: 0 })).toThrow();
  });
});
