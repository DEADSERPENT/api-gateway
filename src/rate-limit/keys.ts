import { createHash } from 'node:crypto';

/**
 * Redis key for one (service, subject) bucket. The subject is hashed so the key has a
 * fixed length and charset whatever the token contains: no key injection, and no way to
 * inflate key size. Cardinality is bounded by the number of distinct verified subjects.
 */
export function rateLimitKey(service: string, subject: string): string {
  const digest = createHash('sha256').update(subject).digest('hex').slice(0, 32);
  return `rl:v1:${service}:${digest}`;
}
