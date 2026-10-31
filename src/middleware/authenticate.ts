import { createPublicKey, type KeyObject } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { jwtVerify } from 'jose';
import { GatewayError } from '../proxy/upstream-errors.js';

/** Only asymmetric RS256 is accepted: this blocks `none` and HS256 key-confusion tokens. */
const ALLOWED_ALGORITHMS = ['RS256'];

export interface JwtConfig {
  publicKeyPem: string;
  issuer: string;
  audience: string;
}

export function createAuthenticator(cfg: JwtConfig) {
  const key: KeyObject = createPublicKey(cfg.publicKeyPem);

  /** Returns the verified subject, or throws a 401 GatewayError. */
  return async function authenticate(request: FastifyRequest): Promise<string> {
    const unauthenticated = () =>
      new GatewayError(401, 'UNAUTHENTICATED', 'Missing or invalid credentials', {
        'www-authenticate': 'Bearer',
      });
    const header = request.headers.authorization;
    const match = header ? /^Bearer ([\w-]+\.[\w-]+\.[\w-]*)$/.exec(header) : null;
    if (!match?.[1]) throw unauthenticated();
    try {
      const { payload } = await jwtVerify(match[1], key, {
        algorithms: ALLOWED_ALGORITHMS,
        issuer: cfg.issuer,
        audience: cfg.audience,
        requiredClaims: ['sub', 'exp'],
      });
      const sub = payload.sub;
      if (!sub || sub.length > 256 || /[\r\n]/.test(sub)) throw unauthenticated();
      return sub;
    } catch (e) {
      if (e instanceof GatewayError) throw e;
      throw unauthenticated();
    }
  };
}
