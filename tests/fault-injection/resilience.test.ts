import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

async function call(path: string) {
  return h.gateway.inject({
    url: path,
    headers: { authorization: `Bearer ${await h.token()}` },
  });
}
const setMode = (svc: 'a' | 'b', mode: string) =>
  h[svc].app.inject({ method: 'POST', url: '/admin/mode', payload: { mode } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('timeouts and upstream errors', () => {
  it('maps an upstream timeout to 504 within the deadline', async () => {
    await setMode('a', 'hang');
    const t0 = Date.now();
    const res = await call('/api/v1/service-a/ping');
    expect(res.statusCode).toBe(504);
    expect(res.json().error.code).toBe('UPSTREAM_TIMEOUT');
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('maps an unreachable upstream to 503 without leaking its address', async () => {
    await h.b.app.close();
    const res = await call('/api/v1/service-b/ping');
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(res.body).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
  });
});

describe('circuit breaker through the gateway', () => {
  it('opens after the threshold, fails fast, and stops calling the upstream', async () => {
    await setMode('b', 'fail');
    for (let i = 0; i < 3; i++) {
      expect((await call('/api/v1/service-b/ping')).statusCode).toBe(500);
    }
    const callsBefore = h.b.calls;
    const t0 = Date.now();
    const res = await call('/api/v1/service-b/ping');
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('CIRCUIT_OPEN');
    expect(res.headers['retry-after']).toBeTruthy();
    expect(Date.now() - t0).toBeLessThan(100);
    expect(h.b.calls).toBe(callsBefore);
  });

  it('isolates breakers per service', async () => {
    await setMode('b', 'fail');
    for (let i = 0; i < 4; i++) await call('/api/v1/service-b/ping');
    expect((await call('/api/v1/service-a/ping')).statusCode).toBe(200);
  });

  it('does not trip on client errors (4xx)', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await call('/api/v1/service-a/status/404')).statusCode).toBe(404);
    }
    expect((await call('/api/v1/service-a/ping')).statusCode).toBe(200);
  });

  it('recovers through a half-open probe once the upstream is healthy', async () => {
    await setMode('b', 'fail');
    for (let i = 0; i < 3; i++) await call('/api/v1/service-b/ping');
    expect((await call('/api/v1/service-b/ping')).statusCode).toBe(503);

    await setMode('b', 'ok');
    await sleep(250); // cooldown is 200ms in the test config
    expect((await call('/api/v1/service-b/ping')).statusCode).toBe(200); // probe
    expect((await call('/api/v1/service-b/ping')).statusCode).toBe(200); // closed again
  });

  it('a failing probe reopens the breaker', async () => {
    await setMode('b', 'fail');
    for (let i = 0; i < 3; i++) await call('/api/v1/service-b/ping');
    await sleep(250);
    expect((await call('/api/v1/service-b/ping')).statusCode).toBe(500); // probe fails
    expect((await call('/api/v1/service-b/ping')).statusCode).toBe(503);
  });

  it('timeouts count toward opening the breaker', async () => {
    await setMode('a', 'hang');
    for (let i = 0; i < 3; i++) {
      expect((await call('/api/v1/service-a/ping')).statusCode).toBe(504);
    }
    expect((await call('/api/v1/service-a/ping')).statusCode).toBe(503);
  });
});

describe('metrics', () => {
  it('exposes counters for requests, upstream failures and breaker transitions', async () => {
    await setMode('b', 'fail');
    for (let i = 0; i < 4; i++) await call('/api/v1/service-b/ping');
    const text = (await h.gateway.inject('/metrics')).body;
    expect(text).toMatch(/gateway_requests_total\{[^}]*status="500"[^}]*\} 3/);
    expect(text).toMatch(/gateway_upstream_failures_total\{service="service-b"\} 3/);
    expect(text).toMatch(/gateway_breaker_transitions_total\{service="service-b",to="OPEN"\} 1/);
    expect(text).toMatch(/gateway_circuit_open_rejections_total\{service="service-b"\} 1/);
  });
});
