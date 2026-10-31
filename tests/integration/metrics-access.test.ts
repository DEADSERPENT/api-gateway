import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../helpers.js';

const TOKEN = 'metrics-secret-0123456789';
let h: Harness;

beforeAll(async () => {
  h = await startHarness({ metricsToken: TOKEN });
});
afterAll(async () => {
  await h.close();
});

describe('/metrics access control (when METRICS_TOKEN is configured)', () => {
  it('rejects requests without a token', async () => {
    const res = await h.gateway.inject('/metrics');
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toMatch(/gateway_requests_total/);
  });

  it('rejects a wrong token, including one of a different length', async () => {
    for (const bad of ['nope', TOKEN + 'x', TOKEN.slice(0, -1)]) {
      const res = await h.gateway.inject({
        url: '/metrics',
        headers: { authorization: `Bearer ${bad}` },
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('accepts the configured token', async () => {
    const res = await h.gateway.inject({
      url: '/metrics',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('# TYPE');
  });

  it('keeps liveness and readiness open and free of detail', async () => {
    expect((await h.gateway.inject('/health/live')).json()).toEqual({ status: 'ok' });
    expect((await h.gateway.inject('/health/ready')).json()).toEqual({ status: 'ready' });
  });
});
