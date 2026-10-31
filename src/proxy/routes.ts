import replyFrom from '@fastify/reply-from';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CircuitBreaker } from '../circuit-breaker/breaker.js';
import type { BreakerConfig, RateLimitConfig, ServiceConfig } from '../config/env.js';
import type { Metrics } from '../observability/metrics.js';
import { ipKey, rateLimitKey } from '../rate-limit/keys.js';
import type { RateLimiter } from '../rate-limit/token-bucket.js';
import { classifyUpstreamError, GatewayError, sendError } from './upstream-errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    authenticatedUser?: string;
  }
}

export interface ProxyDeps {
  metrics: Metrics;
  authenticate: (request: FastifyRequest) => Promise<string>;
  upstreamTimeoutMs: number;
  breaker: BreakerConfig;
  rateLimit: RateLimitConfig;
  /** Absent only in tests that do not exercise limiting. */
  rateLimiter: RateLimiter | undefined;
  /** Per-IP limiter run before authentication. Absent = disabled. */
  ipRateLimiter: RateLimiter | undefined;
}

/** Headers the gateway alone may set; anything a client sends for them is discarded. */
const isInternalHeader = (name: string) =>
  name === 'authorization' ||
  name === 'cookie' ||
  name === 'x-request-id' ||
  name.startsWith('x-authenticated-') ||
  name.startsWith('x-internal-');

export function registerServiceProxy(app: FastifyInstance, svc: ServiceConfig, deps: ProxyDeps) {
  const { metrics, breaker: bc } = deps;
  const breaker = new CircuitBreaker({
    failureThreshold: bc.failureThreshold,
    windowMs: bc.windowMs,
    cooldownMs: bc.cooldownMs,
    halfOpenMaxProbes: bc.halfOpenMaxProbes,
    onTransition: (_from, to) => {
      metrics.inc('gateway_breaker_transitions_total', { service: svc.name, to });
      app.log.warn({ service: svc.name, to }, 'circuit breaker transition');
    },
  });

  // Each service gets its own encapsulated scope: its own upstream pool and breaker.
  app.register(async (scope) => {
    await scope.register(replyFrom, {
      base: svc.upstream,
      undici: {
        headersTimeout: deps.upstreamTimeoutMs,
        bodyTimeout: deps.upstreamTimeoutMs,
        connectTimeout: deps.upstreamTimeoutMs,
      },
    });

    // Applies the outage policy when a limiter (Redis) fails: `undefined` means "let the
    // request through" (fail-open); otherwise the request is refused with 503 (fail-closed).
    const consume = async (limiter: RateLimiter, key: string, request: FastifyRequest) => {
      const policy = deps.rateLimit.failurePolicy;
      try {
        return await limiter.consume(key);
      } catch (err) {
        metrics.inc('gateway_rate_limiter_errors_total', { policy });
        request.log.error({ err }, 'rate limiter unavailable');
        if (policy === 'open') return undefined;
        throw new GatewayError(503, 'RATE_LIMITER_UNAVAILABLE', 'Service temporarily unavailable', {
          'retry-after': '1',
        });
      }
    };
    const retryAfter = (ms: number) => String(Math.max(1, Math.ceil(ms / 1000)));

    // 1. Per-IP limit, BEFORE authentication, so floods of invalid tokens are throttled too.
    scope.addHook('preHandler', async (request) => {
      if (!deps.ipRateLimiter) return;
      const result = await consume(deps.ipRateLimiter, ipKey(request.ip), request);
      if (result && !result.allowed) {
        metrics.inc('gateway_ip_rate_limit_rejections_total', { service: svc.name });
        throw new GatewayError(429, 'IP_RATE_LIMIT_EXCEEDED', 'Too many requests', {
          'retry-after': retryAfter(result.retryAfterMs),
        });
      }
    });

    // 2. Authentication.
    scope.addHook('preHandler', async (request) => {
      request.authenticatedUser = await deps.authenticate(request);
    });

    // 3. Per-user limit: after authentication (the identity is verified) and before the
    // breaker (throttled requests never consume breaker permits or reach the upstream).
    scope.addHook('preHandler', async (request, reply) => {
      if (!deps.rateLimiter) return;
      const result = await consume(
        deps.rateLimiter,
        rateLimitKey(svc.name, request.authenticatedUser as string),
        request,
      );
      if (!result) return;
      reply.header('ratelimit-limit', String(result.limit));
      reply.header('ratelimit-remaining', String(result.remaining));
      reply.header('ratelimit-reset', String(Math.ceil(result.resetMs / 1000)));
      if (!result.allowed) {
        metrics.inc('gateway_rate_limit_rejections_total', { service: svc.name });
        throw new GatewayError(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests', {
          'retry-after': retryAfter(result.retryAfterMs),
        });
      }
    });

    const forward = async (
      request: FastifyRequest<{ Params: { '*'?: string } }>,
      reply: FastifyReply,
    ) => {
      const ticket = breaker.tryAcquire();
      if (!ticket) {
        metrics.inc('gateway_circuit_open_rejections_total', { service: svc.name });
        throw new GatewayError(503, 'CIRCUIT_OPEN', 'Service temporarily unavailable', {
          'retry-after': String(Math.max(1, Math.ceil(breaker.retryAfterMs() / 1000))),
        });
      }
      // If the client disconnects before an outcome is known, release the permit.
      reply.raw.on('close', () => ticket.ignore());

      const qIdx = request.url.indexOf('?');
      const search = qIdx === -1 ? '' : request.url.slice(qIdx);
      const path = `/${request.params['*'] ?? ''}${search}`;
      const user = request.authenticatedUser as string;

      return reply.from(path, {
        rewriteRequestHeaders: (_req, headers) => {
          const out: Record<string, string | string[] | undefined> = {};
          for (const [k, v] of Object.entries(headers)) if (!isInternalHeader(k)) out[k] = v;
          out['x-request-id'] = request.id;
          out['x-authenticated-user'] = user;
          return out;
        },
        onResponse: (_req, rep, res) => {
          if (bc.failureStatusCodes.includes(res.statusCode)) {
            ticket.failure();
            metrics.inc('gateway_upstream_failures_total', { service: svc.name });
          } else {
            ticket.success();
          }
          rep.send(res.stream);
        },
        onError: (rep, { error }) => {
          ticket.failure();
          metrics.inc('gateway_upstream_failures_total', { service: svc.name });
          if (classifyUpstreamError(error) === 'timeout') {
            metrics.inc('gateway_upstream_timeouts_total', { service: svc.name });
            sendError(rep, new GatewayError(504, 'UPSTREAM_TIMEOUT', 'Upstream timed out'));
          } else {
            sendError(
              rep,
              new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Service temporarily unavailable'),
            );
          }
        },
      });
    };

    const routeConfig = { config: { service: svc.name } };
    scope.all(`${svc.prefix}`, routeConfig, forward);
    scope.all(`${svc.prefix}/*`, routeConfig, forward);
  });
}
