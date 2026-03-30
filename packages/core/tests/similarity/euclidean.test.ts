import { describe, it, expect } from 'vitest';
import { euclideanSimilarity } from '../../src/similarity/euclidean.js';
import type { QuantizedVector } from '../../src/types.js';

function vec(...values: number[]): QuantizedVector {
  return { data: Float64Array.from(values) };
}

describe('euclidean similarity', () => {
  it('returns 1.0 for identical vectors', () => {
    expect(euclideanSimilarity(vec(1, 2, 3), vec(1, 2, 3))).toBeCloseTo(1.0);
  });

  it('returns value in (0, 1] range', () => {
    const score = euclideanSimilarity(vec(0, 0), vec(100, 100));
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('computes known value', () => {
    // dist([0,0], [3,4]) = 5, similarity = 1/(1+5) = 1/6 ≈ 0.1667
    const score = euclideanSimilarity(vec(0, 0), vec(3, 4));
    expect(score).toBeCloseTo(1 / 6, 4);
  });
});
