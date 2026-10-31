import Fastify, { type FastifyInstance } from 'fastify';

export type Mode = 'ok' | 'fail' | 'hang';

export interface MockService {
  app: FastifyInstance;
  /** Requests handled by business routes (admin routes excluded). */
  readonly calls: number;
}

/**
 * Deterministic downstream used for tests and the demo. `POST /admin/mode` injects
 * faults: `fail` answers 500, `hang` never answers (until the caller gives up).
 */
export function buildMockService(name: string): MockService {
  const app = Fastify({ logger: false });
  let mode: Mode = 'ok';
  let calls = 0;

  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.post<{ Body: { mode: Mode } }>('/admin/mode', async (req) => {
    mode = req.body.mode;
    return { mode };
  });
  app.get('/admin/stats', async () => ({ calls, mode }));

  app.addHook('preHandler', async (req, reply) => {
    if (req.url.startsWith('/admin/')) return;
    calls++;
    if (mode === 'fail') return reply.code(500).send({ service: name, error: 'injected failure' });
    if (mode === 'hang') return new Promise<void>(() => undefined);
  });

  const describeRequest = (req: import('fastify').FastifyRequest) => ({
    service: name,
    method: req.method,
    path: req.url.split('?')[0],
    query: req.query,
    body: req.body ?? null,
    requestId: req.headers['x-request-id'] ?? null,
    authenticatedUser: req.headers['x-authenticated-user'] ?? null,
    receivedAuthorization: req.headers['authorization'] !== undefined,
  });

  app.get('/ping', async (req) => describeRequest(req));
  app.all('/echo', async (req) => describeRequest(req));
  app.get<{ Params: { code: string } }>('/status/:code', async (req, reply) =>
    reply.code(Number(req.params.code)).send({ service: name }),
  );

  return {
    app,
    get calls() {
      return calls;
    },
  };
}
