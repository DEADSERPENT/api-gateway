import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
import { RedisTokenBucket } from './rate-limit/token-bucket.js';

const config = loadConfig();

// Fail fast rather than queueing commands while Redis is down: a queued rate-limit check
// would hold the request open, so the outage policy must be applied immediately.
const redis = new Redis(config.redisUrl, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 0,
  commandTimeout: 200,
  connectTimeout: 1_000,
  retryStrategy: (attempt) => Math.min(attempt * 100, 2_000),
});
let lastRedisError = 0;
redis.on('error', (err: Error) => {
  // Reconnect attempts are noisy; log at most once per 5s and never the connection URL.
  if (Date.now() - lastRedisError > 5_000) {
    lastRedisError = Date.now();
    console.error(JSON.stringify({ level: 'error', msg: 'redis error', code: (err as NodeJS.ErrnoException).code }));
  }
});

const app = await buildApp(config, {
  rateLimiter: new RedisTokenBucket(redis, config.rateLimit),
  ...(config.ipRateLimit ? { ipRateLimiter: new RedisTokenBucket(redis, config.ipRateLimit) } : {}),
  readinessChecks: [async () => (await redis.ping()) === 'PONG'],
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    app
      .close()
      .then(() => redis.quit())
      .then(
        () => process.exit(0),
        () => process.exit(1),
      );
  });
}

await app.listen({ port: config.port, host: config.host });
