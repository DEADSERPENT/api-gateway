import { describe, expect, it } from 'vitest';
import { buildMockService } from '../../services/mock-service.js';

const setMode = (svc: ReturnType<typeof buildMockService>, mode: string) =>
  svc.app.inject({ method: 'POST', url: '/admin/mode', payload: { mode } });

describe('mock service fault injection', () => {
  it('reports the instant the mode actually changed', async () => {
    const svc = buildMockService('svc');
    const before = Date.now();
    const res = await setMode(svc, 'fail');
    const after = Date.now();
    const body = res.json();
    expect(body.mode).toBe('fail');
    expect(body.changedAtMs).toBeGreaterThanOrEqual(before);
    expect(body.changedAtMs).toBeLessThanOrEqual(after);
  });

  it('applies the new mode no later than the reported instant', async () => {
    const svc = buildMockService('svc');
    await setMode(svc, 'fail');
    expect((await svc.app.inject('/ping')).statusCode).toBe(500);
    const restored = await setMode(svc, 'ok');
    // Any request issued after the reply carries a timestamp >= changedAtMs and must succeed.
    const t = Date.now();
    expect(t).toBeGreaterThanOrEqual(restored.json().changedAtMs);
    expect((await svc.app.inject('/ping')).statusCode).toBe(200);
  });

  it('exposes the last change time via /admin/stats', async () => {
    const svc = buildMockService('svc');
    const { changedAtMs } = (await setMode(svc, 'fail')).json();
    const stats = (await svc.app.inject('/admin/stats')).json();
    expect(stats.mode).toBe('fail');
    expect(stats.changedAtMs).toBe(changedAtMs);
  });

  it('does not count admin calls as business calls', async () => {
    const svc = buildMockService('svc');
    await setMode(svc, 'ok');
    await svc.app.inject('/admin/stats');
    expect(svc.calls).toBe(0);
  });
});
