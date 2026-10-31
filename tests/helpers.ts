import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import type { FastifyInstance } from 'fastify';
import { buildMockService, type MockService } from '../services/mock-service.js';
import { buildApp } from '../src/app.js';
import type { GatewayConfig } from '../src/config/env.js';
import type { RateLimiter } from '../src/rate-limit/token-bucket.js';
import type { ReadinessCheck } from '../src/routes/health.js';

export const ISSUER = 'https://issuer.test';
export const AUDIENCE = 'api-gateway';

export interface Keys {
  privateKey: CryptoKey;
  publicKeyPem: string;
}

export async function makeKeys(): Promise<Keys> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  return { privateKey, publicKeyPem: await exportSPKI(publicKey) };
}

export async function signToken(
  keys: Keys,
  opts: { sub?: string; expiresIn?: string | number; issuer?: string; audience?: string } = {},
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(opts.sub ?? 'user-1')
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '5m')
    .sign(keys.privateKey);
}

export interface Extras {
  rateLimiter?: RateLimiter;
  readinessChecks?: ReadinessCheck[];
}

export interface Harness {
  config: GatewayConfig;
  gateway: FastifyInstance;
  a: MockService;
  b: MockService;
  keys: Keys;
  token: (sub?: string) => Promise<string>;
  close: () => Promise<void>;
}

export async function startHarness(
  overrides: Partial<GatewayConfig> = {},
  logStream?: NodeJS.WritableStream,
  extras: Extras = {},
): Promise<Harness> {
  const a = buildMockService('service-a');
  const b = buildMockService('service-b');
  await a.app.listen({ port: 0, host: '127.0.0.1' });
  await b.app.listen({ port: 0, host: '127.0.0.1' });
  const keys = await makeKeys();
  const urlOf = (s: MockService) => {
    const addr = s.app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    return `http://127.0.0.1:${addr.port}`;
  };
  const config: GatewayConfig = {
    port: 0,
    host: '127.0.0.1',
    bodyLimitBytes: 1024,
    upstreamTimeoutMs: 500,
    jwt: { publicKeyPem: keys.publicKeyPem, issuer: ISSUER, audience: AUDIENCE },
    services: [
      { name: 'service-a', prefix: '/api/v1/service-a', upstream: urlOf(a) },
      { name: 'service-b', prefix: '/api/v1/service-b', upstream: urlOf(b) },
    ],
    breaker: {
      failureThreshold: 3,
      windowMs: 10_000,
      cooldownMs: 200,
      halfOpenMaxProbes: 1,
      failureStatusCodes: [500, 502, 503, 504],
    },
    rateLimit: { capacity: 10, refillPerSec: 0.001, failurePolicy: 'closed' },
    redisUrl: 'redis://127.0.0.1:6379',
    ...overrides,
  };
  const gateway = await buildApp(config, {
    ...(logStream ? { logStream, logLevel: 'info' } : { logLevel: 'silent' }),
    ...extras,
  });
  await gateway.ready();
  return {
    config,
    gateway,
    a,
    b,
    keys,
    token: (sub) => signToken(keys, sub ? { sub } : {}),
    close: async () => {
      await gateway.close();
      await a.app.close();
      await b.app.close();
    },
  };
}

/** A second gateway in front of the same upstreams, for shared-state tests. */
export async function startReplica(h: Harness, extras: Extras = {}): Promise<FastifyInstance> {
  const replica = await buildApp(h.config, { logLevel: 'silent', ...extras });
  await replica.ready();
  return replica;
}
