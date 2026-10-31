import type { FastifyInstance } from 'fastify';

export type ReadinessCheck = () => Promise<boolean>;

/** Liveness is process-only; readiness aggregates dependency checks without exposing details. */
export function registerHealth(app: FastifyInstance, checks: ReadinessCheck[]): void {
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_req, reply) => {
    const results = await Promise.all(
      checks.map((c) => c().catch(() => false)),
    );
    if (results.every(Boolean)) return { status: 'ready' };
    return reply.code(503).send({ status: 'not_ready' });
  });
}
