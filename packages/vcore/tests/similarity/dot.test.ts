import { describe, it, expect } from 'vitest';
import { dotSimilarity } from '../../src/similarity/dot.js';
import type { QuantizedVector } from '../../src/types.js';

function vec(...values: number[]): QuantizedVector {
  return { data: Float64Array.from(values) };
}

describe('dot similarity', () => {
  it('computes known dot product', () => {
    // [1,2,3] · [4,5,6] = 4 + 10 + 18 = 32
    expect(dotSimilarity(vec(1, 2, 3), vec(4, 5, 6))).toBe(32);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(dotSimilarity(vec(1, 0), vec(0, 1))).toBe(0);
  });

  it('returns negative for opposite directions', () => {
    expect(dotSimilarity(vec(1, 0), vec(-1, 0))).toBe(-1);
  });
});
