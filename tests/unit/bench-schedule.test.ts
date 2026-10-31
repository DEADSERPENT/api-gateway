import { describe, expect, it } from 'vitest';
import { restoreDelays } from '../../scripts/lib/schedule.mjs';

const RANGE = { minMs: 15_000, spanMs: 3_000 };

describe('restoreDelays (randomised, reproducible restore schedule)', () => {
  it('is deterministic for a given seed', () => {
    expect(restoreDelays(42, 5, RANGE)).toEqual(restoreDelays(42, 5, RANGE));
  });

  it('differs for different seeds', () => {
    expect(restoreDelays(1, 5, RANGE)).not.toEqual(restoreDelays(2, 5, RANGE));
  });

  it('stays inside [min, min + span)', () => {
    for (const seed of [0, 1, 7, 123456, 2 ** 31]) {
      for (const d of restoreDelays(seed, 20, RANGE)) {
        expect(d).toBeGreaterThanOrEqual(RANGE.minMs);
        expect(d).toBeLessThan(RANGE.minMs + RANGE.spanMs);
      }
    }
  });

  it('places exactly one trial in each equal slice of the probe interval', () => {
    // 5 trials -> 5 slices of 600 ms. Pure random sampling could cluster; this cannot.
    const n = 5;
    const slice = RANGE.spanMs / n;
    for (const seed of [3, 99, 2026]) {
      const buckets = restoreDelays(seed, n, RANGE).map((d) => Math.floor((d - RANGE.minMs) / slice));
      expect([...buckets].sort()).toEqual([0, 1, 2, 3, 4]);
    }
  });

  it('shuffles trial order so trial number is not correlated with phase', () => {
    const orders = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seed) =>
        restoreDelays(seed, 5, RANGE)
          .map((d) => Math.floor((d - RANGE.minMs) / 600))
          .join(','),
      ),
    );
    expect(orders.size).toBeGreaterThan(1);
  });

  it('returns whole milliseconds and the requested number of trials', () => {
    const d = restoreDelays(5, 7, RANGE);
    expect(d).toHaveLength(7);
    expect(d.every(Number.isInteger)).toBe(true);
  });

  it('rejects invalid input', () => {
    expect(() => restoreDelays(1, 0, RANGE)).toThrow();
    expect(() => restoreDelays(1, 3, { minMs: 1000, spanMs: 0 })).toThrow();
  });
});
