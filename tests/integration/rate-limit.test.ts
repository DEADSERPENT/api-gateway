import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisTokenBucket, type RateLimiter } from '../../src/rate-limit/token-bucket.js';
import { signToken, startHarness, startReplica, type Harness } from '../helpers.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
const cfg = { capacity: 10, refillPerSec: 0.001 };

let redis: Redis;
let redisB: Redis;
let h: Harness;
let replica: FastifyInstance;

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
  } catch {
    throw new Error(`Redis is required (${REDIS_URL}). Run: docker compose up -d redis`);
  }
  // Two gateways, each with its OWN Redis connection: they share nothing but Redis.
  redisB = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  h = await startHarness({}, undefined, { rateLimiter: new RedisTokenBucket(redis, cfg) });
  replica = await startReplica(h, { rateLimiter: new RedisTokenBucket(redisB, cfg) });
});
afterAll(async () => {
  await replica.close();
  await h.close();
  await redis.quit();
  await redisB.quit();
});

const call = async (
  gw: FastifyInstance,
  sub: string,
  path = '/api/v1/service-a/ping',
  keys = h.keys,
) =>
  gw.inject({
    url: path,
    headers: { authorization: `Bearer ${await signToken(keys, { sub })}` },
  });
const user = () => `u-${randomUUID()}`;

describe('rate limiting', () => {
  it('allows up to the quota then answers 429 with headers', async () => {
    const sub = user();
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await call(h.gateway, sub)).statusCode);
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(codes.slice(10)).toEqual([429, 429]);

    const limited = await call(h.gateway, sub);
    expect(limited.json().error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(limited.json().error.requestId).toBe(limited.headers['x-request-id']);
    expect(limited.headers['retry-after']).toBeTruthy();
    expect(limited.headers['ratelimit-limit']).toBe('10');
    expect(limited.headers['ratelimit-remaining']).toBe('0');
  });

  it('reports remaining quota on successful responses', async () => {
    const sub = user();
    const first = await call(h.gateway, sub);
    expect(first.statusCode).toBe(200);
    expect(first.headers['ratelimit-limit']).toBe('10');
    expect(first.headers['ratelimit-remaining']).toBe('9');
    expect((await call(h.gateway, sub)).headers['ratelimit-remaining']).toBe('8');
  });

  it('rejected requests never reach the upstream', async () => {
    const sub = user();
    for (let i = 0; i < 10; i++) await call(h.gateway, sub);
    const before = h.a.calls;
    for (let i = 0; i < 5; i++) expect((await call(h.gateway, sub)).statusCode).toBe(429);
    expect(h.a.calls).toBe(before);
  });

  it('quotas are per user and per service', async () => {
    const [alice, bob] = [user(), user()];
    for (let i = 0; i < 10; i++) await call(h.gateway, alice);
    expect((await call(h.gateway, alice)).statusCode).toBe(429);
    expect((await call(h.gateway, bob)).statusCode).toBe(200);
    expect((await call(h.gateway, alice, '/api/v1/service-b/ping')).statusCode).toBe(200);
  });

  it('unauthenticated requests get 401 and consume no quota', async () => {
    const sub = user();
    for (let i = 0; i < 30; i++) {
      expect((await h.gateway.inject({ url: '/api/v1/service-a/ping' })).statusCode).toBe(401);
    }
    expect((await call(h.gateway, sub)).headers['ratelimit-remaining']).toBe('9');
  });

  it('429s are not upstream failures and do not trip the breaker', async () => {
    const sub = user();
    for (let i = 0; i < 40; i++) await call(h.gateway, sub);
    expect((await call(h.gateway, user())).statusCode).toBe(200);
  });
});

describe('distributed quota across two gateway instances', () => {
  it('enforces ONE quota for concurrent traffic split across replicas', async () => {
    const sub = user();
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => call(i % 2 ? replica : h.gateway, sub)),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(10);
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(50);
  });

  it('a quota spent on replica A is visible on replica B', async () => {
    const sub = user();
    for (let i = 0; i < 10; i++) await call(h.gateway, sub);
    expect((await call(replica, sub)).statusCode).toBe(429);
  });
});

describe('Redis outage policy', () => {
  const failing: RateLimiter = {
    consume: async () => {
      throw new Error('ECONNREFUSED redis:6379');
    },
  };

  it('fail-closed (default): 503, upstream untouched, no internals leaked', async () => {
    const gw = await startHarness({}, undefined, { rateLimiter: failing });
    try {
      const before = gw.a.calls;
      const res = await call(gw.gateway, user(), undefined, gw.keys);
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('RATE_LIMITER_UNAVAILABLE');
      expect(res.body).not.toMatch(/redis|ECONNREFUSED/i);
      expect(gw.a.calls).toBe(before);
      const metrics = (await gw.gateway.inject('/metrics')).body;
      expect(metrics).toMatch(/gateway_rate_limiter_errors_total\{policy="closed"\} 1/);
    } finally {
      await gw.close();
    }
  });

  it('fail-open: requests pass through and the bypass is counted', async () => {
    const gw = await startHarness({ rateLimit: { ...cfg, failurePolicy: 'open' } }, undefined, {
      rateLimiter: failing,
    });
    try {
      const res = await call(gw.gateway, user(), undefined, gw.keys);
      expect(res.statusCode).toBe(200);
      expect(res.headers['ratelimit-limit']).toBeUndefined();
      const metrics = (await gw.gateway.inject('/metrics')).body;
      expect(metrics).toMatch(/gateway_rate_limiter_errors_total\{policy="open"\} 1/);
    } finally {
      await gw.close();
    }
  });

  it('a genuinely unreachable Redis is handled fast under fail-closed', async () => {
    const dead = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      commandTimeout: 200,
      retryStrategy: () => null,
    });
    dead.on('error', () => undefined);
    const gw = await startHarness({}, undefined, { rateLimiter: new RedisTokenBucket(dead, cfg) });
    try {
      const t0 = Date.now();
      expect((await call(gw.gateway, user(), undefined, gw.keys)).statusCode).toBe(503);
      expect(Date.now() - t0).toBeLessThan(1_500);
    } finally {
      await gw.close();
      dead.disconnect();
    }
  });

  it('readiness reports not_ready when a dependency check fails', async () => {
    const gw = await startHarness({}, undefined, { readinessChecks: [async () => false] });
    try {
      const res = await gw.gateway.inject('/health/ready');
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: 'not_ready' });
      expect((await gw.gateway.inject('/health/live')).statusCode).toBe(200);
    } finally {
      await gw.close();
    }
  });
});
