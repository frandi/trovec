import { describe, it, expect } from 'vitest';
import { int8Codec } from '../../src/quantization/int8.js';

describe('INT8 codec', () => {
  it('encodes to Int8Array', () => {
    const quantized = int8Codec.encode([0.1, 0.5, 0.9]);
    expect(quantized.data).toBeInstanceOf(Int8Array);
  });

  it('stores min and max', () => {
    const quantized = int8Codec.encode([0.1, 0.5, 0.9]);
    expect(quantized.min).toBeCloseTo(0.1);
    expect(quantized.max).toBeCloseTo(0.9);
  });

  it('round-trips with acceptable error', () => {
    const embedding = [0.1, 0.5, 0.9, -0.3, 1.0];
    const quantized = int8Codec.encode(embedding);
    const decoded = int8Codec.decode(quantized);

    for (let i = 0; i < embedding.length; i++) {
      expect(decoded[i]).toBeCloseTo(embedding[i], 1); // within 0.05
    }
  });

  it('handles constant vector', () => {
    const quantized = int8Codec.encode([5, 5, 5]);
    const decoded = int8Codec.decode(quantized);
    expect(decoded).toEqual([5, 5, 5]);
  });

  it('maps min to -128 and max to 127', () => {
    const quantized = int8Codec.encode([0, 1]);
    const data = quantized.data as Int8Array;
    expect(data[0]).toBe(-128); // min maps to -128
    expect(data[1]).toBe(127);  // max maps to round(255) - 128 = 127
  });

  it('handles single-element vector', () => {
    const quantized = int8Codec.encode([42]);
    const decoded = int8Codec.decode(quantized);
    expect(decoded[0]).toBeCloseTo(42);
  });
});
