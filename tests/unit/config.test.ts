import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';

const base = {
  JWT_PUBLIC_KEY_PEM: 'k',
  JWT_ISSUER: 'i',
  JWT_AUDIENCE: 'a',
  SERVICE_A_URL: 'http://a:1',
  SERVICE_B_URL: 'http://b:1',
};
const load = (extra: Record<string, string> = {}) => loadConfig({ ...base, ...extra });

describe('per-IP limiter configuration', () => {
  it('is disabled by default', () => {
    expect(load().ipRateLimit).toBeUndefined();
  });

  it('is enabled by setting both variables', () => {
    const c = load({ IP_RATE_LIMIT_CAPACITY: '200', IP_RATE_LIMIT_REFILL_PER_SEC: '50' });
    expect(c.ipRateLimit).toEqual({ capacity: 200, refillPerSec: 50 });
  });

  it('refuses a half-configured limiter', () => {
    expect(() => load({ IP_RATE_LIMIT_CAPACITY: '200' })).toThrow(/together/);
    expect(() => load({ IP_RATE_LIMIT_REFILL_PER_SEC: '5' })).toThrow(/together/);
  });

  it('rejects invalid values', () => {
    expect(() => load({ IP_RATE_LIMIT_CAPACITY: '0', IP_RATE_LIMIT_REFILL_PER_SEC: '5' })).toThrow();
    expect(() => load({ IP_RATE_LIMIT_CAPACITY: '5', IP_RATE_LIMIT_REFILL_PER_SEC: '-1' })).toThrow();
  });
});

describe('TRUST_PROXY', () => {
  it('does not trust proxies by default', () => {
    expect(load().trustProxy).toBeUndefined();
    expect(load({ TRUST_PROXY: 'false' }).trustProxy).toBeUndefined();
  });

  it('accepts a list of proxy addresses', () => {
    expect(load({ TRUST_PROXY: '10.0.0.0/8, 192.168.1.5' }).trustProxy).toBe('10.0.0.0/8, 192.168.1.5');
  });

  it('refuses "trust everything" and malformed values', () => {
    expect(() => load({ TRUST_PROXY: 'true' })).toThrow(/unsafe/);
    expect(() => load({ TRUST_PROXY: 'not an ip' })).toThrow();
  });
});
