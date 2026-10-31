import { describe, expect, it } from 'vitest';
import { rateLimitKey } from '../../src/rate-limit/keys.js';

describe('rateLimitKey', () => {
  it('is deterministic and scoped by service', () => {
    expect(rateLimitKey('service-a', 'alice')).toBe(rateLimitKey('service-a', 'alice'));
    expect(rateLimitKey('service-a', 'alice')).not.toBe(rateLimitKey('service-b', 'alice'));
    expect(rateLimitKey('service-a', 'alice')).not.toBe(rateLimitKey('service-a', 'bob'));
  });

  it('has bounded length and a safe charset whatever the subject contains', () => {
    for (const subject of ['x'.repeat(100_000), 'a b\r\n*', '../../etc', 'ключ', '']) {
      expect(rateLimitKey('service-a', subject)).toMatch(/^rl:v1:service-a:[0-9a-f]{32}$/);
    }
  });
});
