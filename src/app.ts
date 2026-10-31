import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { GatewayConfig } from './config/env.js';
import { createAuthenticator } from './middleware/authenticate.js';
import { Metrics } from './observability/metrics.js';
import type { RateLimiter } from './rate-limit/token-bucket.js';
import { registerServiceProxy } from './proxy/routes.js';
import { GatewayError, sendError } from './proxy/upstream-errors.js';
import { registerHealth, type ReadinessCheck } from './routes/health.js';

/** Constant-time comparison; hashing first makes the inputs equal length. */
function safeEqual(a: string, b: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export interface AppOptions {
  logStream?: NodeJS.WritableStream;
  logLevel?: string;
  readinessChecks?: ReadinessCheck[];
  rateLimiter?: RateLimiter;
  ipRateLimiter?: RateLimiter;
}

export async function buildApp(
  config: GatewayConfig,
  opts: AppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: config.bodyLimitBytes,
    // Always mint our own id: a client-chosen id could forge or collide in logs.
    genReqId: () => randomUUID(),
    // The per-IP limiter keys on request.ip, so this decides whether X-Forwarded-For counts.
    trustProxy: config.trustProxy ?? false,
    requestIdHeader: false,
    logger: {
      level: opts.logLevel ?? process.env['LOG_LEVEL'] ?? 'info',
      ...(opts.logStream ? { stream: opts.logStream } : {}),
      // `source` is reply-from's log of the upstream path, which includes the query string.
      redact: ['req.headers.authorization', 'req.headers.cookie', 'source'],
      serializers: {
        // Log the path only: query strings can carry tokens.
        req: (req) => ({
          method: req.method,
          path: req.url?.split('?')[0],
          reqId: req.id,
        }),
      },
    },
  });

  const metrics = new Metrics();
  metrics.describe('gateway_requests_total', 'Responses by service and status');
  metrics.describe('gateway_upstream_failures_total', 'Qualifying upstream failures');
  metrics.describe('gateway_upstream_timeouts_total', 'Upstream calls that timed out');
  metrics.describe('gateway_breaker_transitions_total', 'Circuit breaker state transitions');
  metrics.describe('gateway_rate_limit_rejections_total', 'Requests rejected with 429');
  metrics.describe('gateway_ip_rate_limit_rejections_total', 'Requests rejected by the per-IP limit');
  metrics.describe('gateway_rate_limiter_errors_total', 'Rate limiter failures by outage policy');
  metrics.describe('gateway_circuit_open_rejections_total', 'Requests failed fast by an open breaker');

  // Non-HTTP-text bodies are forwarded as raw buffers instead of being rejected (415).
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.addHook('onResponse', async (request, reply) => {
    const service = (request.routeOptions.config as { service?: string } | undefined)?.service;
    metrics.inc('gateway_requests_total', {
      service: service ?? 'gateway',
      status: String(reply.statusCode),
    });
  });

  app.setNotFoundHandler((_req, reply) => {
    sendError(reply, new GatewayError(404, 'NOT_FOUND', 'Route not found'));
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof GatewayError) return sendError(reply, error);
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status === 413) {
      return sendError(reply, new GatewayError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large'));
    }
    if (status >= 400 && status < 500) {
      return sendError(reply, new GatewayError(status, 'BAD_REQUEST', 'Invalid request'));
    }
    request.log.error({ err: error }, 'unhandled gateway error');
    return sendError(reply, new GatewayError(500, 'INTERNAL_ERROR', 'Internal server error'));
  });

  registerHealth(app, opts.readinessChecks ?? []);
  app.get(
    '/metrics',
    {
      // When METRICS_TOKEN is set, scraping requires it. Without one, the endpoint is only
      // as private as the network it is exposed on (deployment-level control).
      preHandler: async (request) => {
        if (config.metricsToken === undefined) return;
        const m = /^Bearer (.+)$/.exec(request.headers.authorization ?? '');
        if (!m?.[1] || !safeEqual(m[1], config.metricsToken)) {
          throw new GatewayError(401, 'UNAUTHENTICATED', 'Missing or invalid credentials', {
            'www-authenticate': 'Bearer',
          });
        }
      },
    },
    async (_req, reply) => reply.type('text/plain; version=0.0.4').send(metrics.render()),
  );

  const authenticate = createAuthenticator(config.jwt);
  for (const svc of config.services) {
    registerServiceProxy(app, svc, {
      metrics,
      authenticate,
      upstreamTimeoutMs: config.upstreamTimeoutMs,
      breaker: config.breaker,
      rateLimit: config.rateLimit,
      rateLimiter: opts.rateLimiter,
      ipRateLimiter: opts.ipRateLimiter,
    });
  }

  return app;
}
