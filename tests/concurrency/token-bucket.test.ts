import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisTokenBucket } from '../../src/rate-limit/token-bucket.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
let redis: Redis;

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
  } catch {
    throw new Error(`Redis is required for these tests (${REDIS_URL}). Run: docker compose up -d redis`);
  }
});
afterAll(async () => {
  await redis.quit();
});

let n = 0;
const freshKey = () => `test:tb:${process.pid}:${Date.now()}:${n++}`;

/** Fake clock: Lua uses the supplied time instead of Redis TIME, making refill deterministic. */
function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

function bucket(capacity: number, refillPerSec: number, c = clock()) {
  return { tb: new RedisTokenBucket(redis, { capacity, refillPerSec, nowMs: c.now }), c };
}

describe('RedisTokenBucket semantics', () => {
  beforeEach(() => undefined);

  it('starts full: the first request is allowed and leaves capacity-1', async () => {
    const { tb } = bucket(5, 1);
    const r = await tb.consume(freshKey());
    expect(r).toMatchObject({ allowed: true, remaining: 4, limit: 5 });
  });

  it('allows exactly `capacity` requests, then rejects (boundary)', async () => {
    const { tb } = bucket(5, 1);
    const key = freshKey();
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await tb.consume(key));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, true, true, false]);
    expect(results[4]!.remaining).toBe(0);
    expect(results[5]!.remaining).toBe(0);
  });

  it('reports how long until the next token when rejecting', async () => {
    const { tb } = bucket(1, 2); // 2 tokens/s -> 500ms per token
    const key = freshKey();
    await tb.consume(key);
    const denied = await tb.consume(key);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(500);
  });

  it('refills over time at the configured rate', async () => {
    const { tb, c } = bucket(5, 2);
    const key = freshKey();
    for (let i = 0; i < 5; i++) await tb.consume(key);
    expect((await tb.consume(key)).allowed).toBe(false);
    c.advance(1_000); // +2 tokens
    expect((await tb.consume(key)).allowed).toBe(true);
    expect((await tb.consume(key)).allowed).toBe(true);
    expect((await tb.consume(key)).allowed).toBe(false);
  });

  it('never refills beyond capacity', async () => {
    const { tb, c } = bucket(3, 10);
    const key = freshKey();
    await tb.consume(key);
    c.advance(60_000);
    const r = await tb.consume(key);
    expect(r.remaining).toBe(2); // capacity 3 - this request
  });

  it('supports a request cost greater than one', async () => {
    const { tb } = bucket(10, 1);
    const key = freshKey();
    expect((await tb.consume(key, 4)).remaining).toBe(6);
    expect((await tb.consume(key, 7)).allowed).toBe(false);
    expect((await tb.consume(key, 6)).allowed).toBe(true);
  });

  it('a rejection does not consume tokens', async () => {
    const { tb, c } = bucket(2, 1);
    const key = freshKey();
    await tb.consume(key, 2);
    for (let i = 0; i < 20; i++) await tb.consume(key); // all denied
    c.advance(1_000);
    expect((await tb.consume(key)).allowed).toBe(true); // exactly 1 token refilled
  });

  it('keys are independent', async () => {
    const { tb } = bucket(1, 0.001);
    const [a, b] = [freshKey(), freshKey()];
    expect((await tb.consume(a)).allowed).toBe(true);
    expect((await tb.consume(a)).allowed).toBe(false);
    expect((await tb.consume(b)).allowed).toBe(true);
  });

  it('sets a TTL covering the time to refill, so idle buckets expire', async () => {
    const { tb } = bucket(10, 5); // 2s to refill fully
    const key = freshKey();
    await tb.consume(key);
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(1_500);
    expect(ttl).toBeLessThanOrEqual(4_000);
  });

  it('an expired (deleted) bucket is recreated full', async () => {
    const { tb } = bucket(3, 0.001);
    const key = freshKey();
    for (let i = 0; i < 3; i++) await tb.consume(key);
    expect((await tb.consume(key)).allowed).toBe(false);
    await redis.del(key);
    expect((await tb.consume(key)).remaining).toBe(2);
  });

  it('uses Redis server time when no clock is injected', async () => {
    const tb = new RedisTokenBucket(redis, { capacity: 2, refillPerSec: 1000 });
    const key = freshKey();
    await tb.consume(key, 2);
    await new Promise((r) => setTimeout(r, 30)); // ~30 tokens of refill, capped at 2
    expect((await tb.consume(key)).allowed).toBe(true);
  });

  it('rejects invalid configuration', () => {
    expect(() => new RedisTokenBucket(redis, { capacity: 0, refillPerSec: 1 })).toThrow();
    expect(() => new RedisTokenBucket(redis, { capacity: 1, refillPerSec: 0 })).toThrow();
  });
});

describe('RedisTokenBucket under concurrency', () => {
  it('grants exactly `capacity` of 500 simultaneous requests on one key', async () => {
    const { tb } = bucket(50, 0.001);
    const key = freshKey();
    const results = await Promise.all(Array.from({ length: 500 }, () => tb.consume(key)));
    expect(results.filter((r) => r.allowed)).toHaveLength(50);
    expect(results.filter((r) => !r.allowed)).toHaveLength(450);
  });

  it('is correct across independent client connections (simulating replicas)', async () => {
    const other = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    try {
      const c = clock();
      const a = new RedisTokenBucket(redis, { capacity: 40, refillPerSec: 0.001, nowMs: c.now });
      const b = new RedisTokenBucket(other, { capacity: 40, refillPerSec: 0.001, nowMs: c.now });
      const key = freshKey();
      const results = await Promise.all(
        Array.from({ length: 400 }, (_, i) => (i % 2 ? a : b).consume(key)),
      );
      expect(results.filter((r) => r.allowed)).toHaveLength(40);
    } finally {
      await other.quit();
    }
  });
});

describe('RedisTokenBucket when Redis is unreachable', () => {
  it('rejects quickly instead of hanging', async () => {
    const dead = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      commandTimeout: 200,
      retryStrategy: () => null,
    });
    dead.on('error', () => undefined);
    const tb = new RedisTokenBucket(dead, { capacity: 1, refillPerSec: 1 });
    const t0 = Date.now();
    await expect(tb.consume('k')).rejects.toBeDefined();
    expect(Date.now() - t0).toBeLessThan(1_500);
    dead.disconnect();
  });
});
