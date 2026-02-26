import { describe, it, expect } from 'vitest';
import { bitCodec } from '../../src/quantization/bit.js';

describe('BIT codec', () => {
  it('encodes positive values as 1 and negative as 0', () => {
    const quantized = bitCodec.encode([1, -1, 0.5, -0.5, 0, 1, -1, 1]);
    const data = quantized.data as Buffer;
    // Expected bits: 1 0 1 0 1 1 0 1 = 0xAD
    expect(data[0]).toBe(0xAD);
  });

  it('zero maps to 1 (>= 0)', () => {
    const quantized = bitCodec.encode([0]);
    const data = quantized.data as Buffer;
    // bit 0 = 1, MSB first in byte: 1000_0000 = 0x80
    expect(data[0]).toBe(0x80);
  });

  it('pads last byte with zeros for non-multiple-of-8 dimensions', () => {
    // 3 dimensions: bits 1,0,1 -> byte: 1010_0000 = 0xA0
    const quantized = bitCodec.encode([1, -1, 1]);
    const data = quantized.data as Buffer;
    expect(data.length).toBe(1);
    expect(data[0]).toBe(0xA0);
  });

  it('stores dimensions for decode', () => {
    const quantized = bitCodec.encode([1, -1, 1]);
    expect(quantized.dimensions).toBe(3);
  });

  it('decodes to +1.0 and -1.0', () => {
    const decoded = bitCodec.decode(bitCodec.encode([1, -1, 0.5, -0.5]));
    expect(decoded).toEqual([1.0, -1.0, 1.0, -1.0]);
  });

  it('does not read padding bits as data', () => {
    const decoded = bitCodec.decode(bitCodec.encode([1, -1, 1]));
    expect(decoded.length).toBe(3);
    expect(decoded).toEqual([1.0, -1.0, 1.0]);
  });

  it('handles 16 dimensions (exact 2 bytes)', () => {
    const embedding = [1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1];
    const quantized = bitCodec.encode(embedding);
    expect((quantized.data as Buffer).length).toBe(2);
    const decoded = bitCodec.decode(quantized);
    expect(decoded).toEqual(embedding.map((v) => (v >= 0 ? 1.0 : -1.0)));
  });
});
