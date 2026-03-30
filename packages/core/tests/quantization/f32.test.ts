import { describe, it, expect } from 'vitest';
import { f32Codec } from '../../src/quantization/f32.js';

describe('F32 codec', () => {
  it('round-trips values exactly', () => {
    const embedding = [1.5, -2.3, 0, 100.001];
    const quantized = f32Codec.encode(embedding);
    const decoded = f32Codec.decode(quantized);

    expect(decoded).toEqual(embedding);
  });

  it('stores as Float64Array', () => {
    const quantized = f32Codec.encode([1, 2, 3]);
    expect(quantized.data).toBeInstanceOf(Float64Array);
  });

  it('handles zero vector', () => {
    const decoded = f32Codec.decode(f32Codec.encode([0, 0, 0]));
    expect(decoded).toEqual([0, 0, 0]);
  });

  it('handles negative values', () => {
    const embedding = [-1, -2, -3];
    const decoded = f32Codec.decode(f32Codec.encode(embedding));
    expect(decoded).toEqual(embedding);
  });
});
