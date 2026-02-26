import { describe, it, expect } from 'vitest';
import { cosineSimilarity } from '../../src/similarity/cosine.js';
import type { QuantizedVector } from '../../src/types.js';

function vec(...values: number[]): QuantizedVector {
  return { data: Float64Array.from(values) };
}

describe('cosine similarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const a = vec(1, 2, 3);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1.0);
  });

  it('returns -1.0 for opposite vectors', () => {
    expect(cosineSimilarity(vec(1, 0), vec(-1, 0))).toBeCloseTo(-1.0);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    expect(cosineSimilarity(vec(1, 0), vec(0, 1))).toBeCloseTo(0.0);
  });

  it('returns 0.0 when one vector is zero', () => {
    expect(cosineSimilarity(vec(0, 0), vec(1, 2))).toBe(0);
  });

  it('returns 0.0 when both vectors are zero', () => {
    expect(cosineSimilarity(vec(0, 0), vec(0, 0))).toBe(0);
  });

  it('computes known value', () => {
    // cos([1,2,3], [4,5,6]) = 32 / (sqrt(14) * sqrt(77)) ≈ 0.9746
    const score = cosineSimilarity(vec(1, 2, 3), vec(4, 5, 6));
    expect(score).toBeCloseTo(0.9746, 3);
  });
});
