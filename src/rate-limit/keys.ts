import { createHash } from 'node:crypto';
import { isIPv6 } from 'node:net';

const digest = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

/**
 * Redis key for one (service, subject) bucket. The subject is hashed so the key has a
 * fixed length and charset whatever the token contains: no key injection, and no way to
 * inflate key size. Cardinality is bounded by the number of distinct verified subjects.
 */
export function rateLimitKey(service: string, subject: string): string {
  return `rl:v1:${service}:${digest(subject)}`;
}

/** Expand an IPv6 address to 8 four-digit hextets (embedded IPv4 tails are not expected). */
function expandV6(addr: string): string[] {
  const [head = '', tail = ''] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = addr.includes('::') && tail ? tail.split(':') : [];
  const fill = addr.includes('::') ? 8 - h.length - t.length : 0;
  return [...h, ...Array<string>(Math.max(0, fill)).fill('0'), ...t].map((x) =>
    x.toLowerCase().padStart(4, '0'),
  );
}

/** Same client, one identity: strip zone ids, unwrap IPv4-mapped IPv6, group IPv6 by /64. */
function normalizeIp(ip: string): string {
  const addr = ip.split('%')[0] ?? ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (mapped?.[1]) return mapped[1];
  if (isIPv6(addr)) return expandV6(addr).slice(0, 4).join(':');
  return addr;
}

/**
 * Redis key for one client IP (shared across services). IPv6 is grouped by /64 so a single
 * host with a whole prefix cannot create unbounded buckets.
 */
export function ipKey(ip: string): string {
  return `rl:v1:ip:${digest(normalizeIp(ip))}`;
}
