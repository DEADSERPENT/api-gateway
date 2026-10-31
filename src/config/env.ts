export interface ServiceConfig {
  name: string;
  /** Public path prefix, e.g. `/api/v1/service-a`. */
  prefix: string;
  /** Upstream base URL from trusted configuration only; never derived from a request. */
  upstream: string;
}

export interface BreakerConfig {
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
  halfOpenMaxProbes: number;
  /** Upstream statuses that count as availability failures (4xx never do). */
  failureStatusCodes: number[];
}

export interface RateLimitConfig {
  /** Burst size B: requests allowed instantly from a full bucket. */
  capacity: number;
  /** Sustained rate r: tokens added per second. */
  refillPerSec: number;
  /**
   * What to do when the limiter (Redis) is unreachable.
   * `closed`: reject with 503, so quotas are never bypassed but Redis becomes a hard dependency.
   * `open`: allow the request, so the gateway stays available but is unthrottled until Redis returns.
   */
  failurePolicy: 'open' | 'closed';
}

export interface GatewayConfig {
  port: number;
  host: string;
  bodyLimitBytes: number;
  upstreamTimeoutMs: number;
  jwt: { publicKeyPem: string; issuer: string; audience: string };
  services: ServiceConfig[];
  breaker: BreakerConfig;
  rateLimit: RateLimitConfig;
  redisUrl: string;
  /** If set, `/metrics` requires `Authorization: Bearer <token>`. */
  metricsToken?: string;
}

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const v = env[key];
  if (v === undefined || v === '') throw new Error(`Missing required environment variable ${key}`);
  return v;
}

function int(env: Env, key: string, fallback: number, min = 0): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${key} must be an integer >= ${min}`);
  return n;
}

function httpUrl(env: Env, key: string): string {
  const v = required(env, key);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`${key} must be a valid URL`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`${key} must be an http(s) URL`);
  }
  return u.origin;
}

export function loadConfig(env: Env = process.env): GatewayConfig {
  return {
    port: int(env, 'PORT', 3000),
    host: env['HOST'] ?? '0.0.0.0',
    bodyLimitBytes: int(env, 'BODY_LIMIT_BYTES', 1_048_576, 1),
    upstreamTimeoutMs: int(env, 'UPSTREAM_TIMEOUT_MS', 3000, 1),
    jwt: {
      publicKeyPem: required(env, 'JWT_PUBLIC_KEY_PEM').replace(/\\n/g, '\n'),
      issuer: required(env, 'JWT_ISSUER'),
      audience: required(env, 'JWT_AUDIENCE'),
    },
    services: [
      { name: 'service-a', prefix: '/api/v1/service-a', upstream: httpUrl(env, 'SERVICE_A_URL') },
      { name: 'service-b', prefix: '/api/v1/service-b', upstream: httpUrl(env, 'SERVICE_B_URL') },
    ],
    breaker: {
      failureThreshold: int(env, 'BREAKER_FAILURE_THRESHOLD', 5, 1),
      windowMs: int(env, 'BREAKER_WINDOW_MS', 10_000, 1),
      cooldownMs: int(env, 'BREAKER_COOLDOWN_MS', 5_000),
      halfOpenMaxProbes: int(env, 'BREAKER_HALF_OPEN_PROBES', 1, 1),
      failureStatusCodes: [500, 502, 503, 504],
    },
    rateLimit: {
      capacity: int(env, 'RATE_LIMIT_CAPACITY', 100, 1),
      refillPerSec: positiveNumber(env, 'RATE_LIMIT_REFILL_PER_SEC', 10),
      failurePolicy: failurePolicy(env),
    },
    redisUrl: env['REDIS_URL'] ?? 'redis://127.0.0.1:6379',
    ...metricsToken(env),
  };
}

function metricsToken(env: Env): { metricsToken?: string } {
  const t = env['METRICS_TOKEN'];
  if (t === undefined || t === '') return {};
  if (t.length < 16) throw new Error('METRICS_TOKEN must be at least 16 characters');
  return { metricsToken: t };
}

function positiveNumber(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a number > 0`);
  return n;
}

function failurePolicy(env: Env): 'open' | 'closed' {
  const v = env['RATE_LIMIT_FAIL_POLICY'] ?? 'closed';
  if (v !== 'open' && v !== 'closed') throw new Error("RATE_LIMIT_FAIL_POLICY must be 'open' or 'closed'");
  return v;
}
