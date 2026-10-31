import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisTokenBucket, type RateLimiter } from '../../src/rate-limit/token-bucket.js';
import { startHarness, startReplica, type Harness } from '../helpers.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
const IP_CAP = { capacity: 5, refillPerSec: 0.001 };

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
  redisB = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  h = await startHarness({}, undefined, { ipRateLimiter: new RedisTokenBucket(redis, IP_CAP) });
  replica = await startReplica(h, { ipRateLimiter: new RedisTokenBucket(redisB, IP_CAP) });
});
afterAll(async () => {
  await replica.close();
  await h.close();
  await redis.quit();
  await redisB.quit();
});

/** A fresh address per test so leftover Redis state never leaks between tests or runs. */
const freshIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
const hit = (gw: FastifyInstance, ip: string, headers: Record<string, string> = {}) =>
  gw.inject({ url: '/api/v1/service-a/ping', remoteAddress: ip, headers });
const validAuth = async () => ({ authorization: `Bearer ${await h.token('someone')}` });

describe('per-IP limiter (runs before JWT verification)', () => {
  it('throttles a flood of invalid tokens: 401s until the bucket is empty, then 429', async () => {
    const ip = freshIp();
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      codes.push((await hit(h.gateway, ip, { authorization: 'Bearer abc.def.ghi' })).statusCode);
    }
    expect(codes).toEqual([401, 401, 401, 401, 401, 429, 429, 429]);
  });

  it('rejects before authentication: even a valid token is refused once the IP is limited', async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) await hit(h.gateway, ip);
    const res = await hit(h.gateway, ip, await validAuth());
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('IP_RATE_LIMIT_EXCEEDED');
    expect(res.headers['retry-after']).toBeTruthy();
    expect(res.json().error.requestId).toBe(res.headers['x-request-id']);
  });

  it('never reaches the upstream once limited', async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) await hit(h.gateway, ip, await validAuth());
    const before = h.a.calls;
    for (let i = 0; i < 5; i++) expect((await hit(h.gateway, ip, await validAuth())).statusCode).toBe(429);
    expect(h.a.calls).toBe(before);
  });

  it('gives each client IP its own bucket', async () => {
    const [a, b] = [freshIp(), freshIp()];
    for (let i = 0; i < 6; i++) await hit(h.gateway, a);
    expect((await hit(h.gateway, a)).statusCode).toBe(429);
    expect((await hit(h.gateway, b, await validAuth())).statusCode).toBe(200);
  });

  it('shares one IP quota across gateway replicas', async () => {
    const ip = freshIp();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => hit(i % 2 ? replica : h.gateway, ip)),
    );
    expect(results.filter((r) => r.statusCode === 401)).toHaveLength(5);
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(15);
  });

  it('ignores X-Forwarded-For unless proxies are trusted (no spoofing a fresh bucket)', async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) await hit(h.gateway, ip);
    const spoofed = await hit(h.gateway, ip, { 'x-forwarded-for': '198.51.100.77' });
    expect(spoofed.statusCode).toBe(429);
  });

  it('does not limit health or metrics endpoints', async () => {
    const ip = freshIp();
    for (let i = 0; i < 15; i++) {
      expect((await h.gateway.inject({ url: '/health/live', remoteAddress: ip })).statusCode).toBe(200);
    }
  });

  it('counts rejections in a metric', async () => {
    const ip = freshIp();
    for (let i = 0; i < 7; i++) await hit(h.gateway, ip);
    const metrics = (await h.gateway.inject('/metrics')).body;
    expect(metrics).toMatch(/gateway_ip_rate_limit_rejections_total\{service="service-a"\} \d+/);
  });
});

describe('per-IP limiter configuration and failure', () => {
  const failing: RateLimiter = {
    consume: async () => {
      throw new Error('ECONNREFUSED redis:6379');
    },
  };

  it('is off when not configured: unauthenticated floods just get 401', async () => {
    const gw = await startHarness();
    try {
      const ip = freshIp();
      for (let i = 0; i < 30; i++) {
        expect((await hit(gw.gateway, ip)).statusCode).toBe(401);
      }
    } finally {
      await gw.close();
    }
  });

  it('uses X-Forwarded-For when proxies are trusted', async () => {
    const gw = await startHarness({ trustProxy: true }, undefined, {
      ipRateLimiter: new RedisTokenBucket(redis, IP_CAP),
    });
    try {
      const [a, b] = [freshIp(), freshIp()];
      for (let i = 0; i < 6; i++) await hit(gw.gateway, '127.0.0.1', { 'x-forwarded-for': a });
      expect((await hit(gw.gateway, '127.0.0.1', { 'x-forwarded-for': a })).statusCode).toBe(429);
      expect((await hit(gw.gateway, '127.0.0.1', { 'x-forwarded-for': b })).statusCode).toBe(401);
    } finally {
      await gw.close();
    }
  });

  it('fail-closed: 503 and no JWT check or upstream call when Redis is down', async () => {
    const gw = await startHarness({}, undefined, { ipRateLimiter: failing });
    try {
      const res = await hit(gw.gateway, freshIp(), await validAuth());
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('RATE_LIMITER_UNAVAILABLE');
      expect(res.body).not.toMatch(/redis|ECONNREFUSED/i);
      expect(gw.a.calls).toBe(0);
    } finally {
      await gw.close();
    }
  });

  it('fail-open: carries on to authentication when the limiter fails', async () => {
    const gw = await startHarness(
      { rateLimit: { capacity: 10, refillPerSec: 0.001, failurePolicy: 'open' } },
      undefined,
      { ipRateLimiter: failing },
    );
    try {
      const res = await hit(gw.gateway, freshIp(), { authorization: `Bearer ${await gw.token()}` });
      expect(res.statusCode).toBe(200);
      const metrics = (await gw.gateway.inject('/metrics')).body;
      expect(metrics).toMatch(/gateway_rate_limiter_errors_total\{policy="open"\} 1/);
    } finally {
      await gw.close();
    }
  });
});
