import { describe, it, expect } from 'vitest';
import { hammingSimilarity } from '../../src/similarity/hamming.js';
import { bitCodec } from '../../src/quantization/bit.js';

describe('hamming similarity', () => {
  it('returns 1.0 for identical bit vectors', () => {
    const a = bitCodec.encode([1, -1, 1, -1, 1, -1, 1, -1]);
    expect(hammingSimilarity(a, a)).toBeCloseTo(1.0);
  });

  it('returns 0.0 for completely opposite bit vectors', () => {
    const a = bitCodec.encode([1, 1, 1, 1, 1, 1, 1, 1]);
    const b = bitCodec.encode([-1, -1, -1, -1, -1, -1, -1, -1]);
    expect(hammingSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it('computes known ratio', () => {
    // 6 out of 8 match
    const a = bitCodec.encode([1, 1, 1, 1, 1, 1, -1, -1]);
    const b = bitCodec.encode([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(hammingSimilarity(a, b)).toBeCloseTo(6 / 8);
  });

  it('handles non-multiple-of-8 dimensions', () => {
    // 3 dimensions: all same -> 1.0
    const a = bitCodec.encode([1, -1, 1]);
    const b = bitCodec.encode([1, -1, 1]);
    expect(hammingSimilarity(a, b)).toBeCloseTo(1.0);
  });

  it('handles non-multiple-of-8 with some mismatches', () => {
    // 3 dimensions: 2 out of 3 match
    const a = bitCodec.encode([1, -1, 1]);
    const b = bitCodec.encode([1, -1, -1]);
    expect(hammingSimilarity(a, b)).toBeCloseTo(2 / 3);
  });
});
