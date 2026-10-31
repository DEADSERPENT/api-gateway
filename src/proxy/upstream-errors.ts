/** The slice of FastifyReply we need; structural so it accepts reply-from's reply type too. */
interface ErrorReply {
  headers(h: Record<string, string>): unknown;
  code(status: number): { send(body: unknown): unknown };
  request: { id: string };
}

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** Single place where error bodies are shaped; never includes stacks or upstream details. */
export function sendError(reply: ErrorReply, err: GatewayError): void {
  reply.headers(err.headers);
  reply
    .code(err.status)
    .send({ error: { code: err.code, message: err.message, requestId: reply.request.id } });
}

export type UpstreamFailureKind = 'timeout' | 'unavailable';

/** Classify an error raised while calling an upstream. */
export function classifyUpstreamError(err: unknown): UpstreamFailureKind {
  const e = err as { code?: string; statusCode?: number; message?: string };
  if (e.statusCode === 504 || /TIMEOUT/i.test(e.code ?? '') || /timeout/i.test(e.message ?? '')) {
    return 'timeout';
  }
  return 'unavailable';
}
