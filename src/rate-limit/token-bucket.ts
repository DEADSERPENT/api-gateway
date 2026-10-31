import { readFileSync } from 'node:fs';
import type { Redis } from 'ioredis';

export interface RateLimitResult {
  allowed: boolean;
  /** Whole tokens left after this request. */
  remaining: number;
  limit: number;
  /** When rejected: ms until enough tokens exist for this request. 0 when allowed. */
  retryAfterMs: number;
  /** Ms until the bucket is completely full again. */
  resetMs: number;
}

export interface RateLimiter {
  consume(key: string, cost?: number): Promise<RateLimitResult>;
}

export interface TokenBucketOptions {
  capacity: number;
  refillPerSec: number;
  /** Test hook. Production leaves this unset so Redis server time is the single clock. */
  nowMs?: () => number;
}

interface BucketCommand {
  apptwinTokenBucket(
    key: string,
    capacity: number,
    refillPerSec: number,
    cost: number,
    nowMs: string,
  ): Promise<[number, number, number, number]>;
}

const LUA = readFileSync(new URL('./token-bucket.lua', import.meta.url), 'utf8');

export class RedisTokenBucket implements RateLimiter {
  private readonly cmd: BucketCommand;

  constructor(
    redis: Redis,
    private readonly opts: TokenBucketOptions,
  ) {
    if (!(opts.capacity >= 1)) throw new RangeError('capacity must be >= 1');
    if (!(opts.refillPerSec > 0)) throw new RangeError('refillPerSec must be > 0');
    redis.defineCommand('apptwinTokenBucket', { numberOfKeys: 1, lua: LUA });
    this.cmd = redis as unknown as BucketCommand;
  }

  async consume(key: string, cost = 1): Promise<RateLimitResult> {
    if (!(cost >= 1) || cost > this.opts.capacity) {
      throw new RangeError('cost must be between 1 and capacity');
    }
    const [allowed, remaining, retryAfterMs, resetMs] = await this.cmd.apptwinTokenBucket(
      key,
      this.opts.capacity,
      this.opts.refillPerSec,
      cost,
      this.opts.nowMs ? String(this.opts.nowMs()) : '',
    );
    return { allowed: allowed === 1, remaining, limit: this.opts.capacity, retryAfterMs, resetMs };
  }
}
