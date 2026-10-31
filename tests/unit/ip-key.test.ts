import { describe, expect, it } from 'vitest';
import { ipKey } from '../../src/rate-limit/keys.js';

describe('ipKey', () => {
  it('has a fixed size and safe charset whatever the input', () => {
    for (const ip of ['203.0.113.9', '2001:db8::1', 'x'.repeat(10_000), '', 'a b\r\n*']) {
      expect(ipKey(ip)).toMatch(/^rl:v1:ip:[0-9a-f]{32}$/);
    }
  });

  it('is stable and distinguishes IPv4 addresses', () => {
    expect(ipKey('203.0.113.9')).toBe(ipKey('203.0.113.9'));
    expect(ipKey('203.0.113.9')).not.toBe(ipKey('203.0.113.10'));
  });

  it('treats an IPv4-mapped IPv6 address as the same client as the IPv4 address', () => {
    expect(ipKey('::ffff:203.0.113.9')).toBe(ipKey('203.0.113.9'));
  });

  it('groups IPv6 by /64 so one host cannot mint endless buckets', () => {
    const a = ipKey('2001:db8:0:1:aaaa:bbbb:cccc:dddd');
    expect(ipKey('2001:db8:0:1::5')).toBe(a);
    expect(ipKey('2001:0db8:0000:0001:ffff:ffff:ffff:ffff')).toBe(a);
    expect(ipKey('2001:db8:0:2::5')).not.toBe(a);
  });

  it('ignores an IPv6 zone id', () => {
    expect(ipKey('fe80::1%eth0')).toBe(ipKey('fe80::1'));
  });
});
