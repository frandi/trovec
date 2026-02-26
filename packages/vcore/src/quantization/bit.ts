import type { QuantizationCodec, QuantizedVector } from '../types.js';

export const bitCodec: QuantizationCodec = {
  type: 'BIT',

  encode(embedding: number[]): QuantizedVector {
    const byteCount = Math.ceil(embedding.length / 8);
    const data = Buffer.alloc(byteCount);

    for (let i = 0; i < embedding.length; i++) {
      if (embedding[i] >= 0) {
        const byteIndex = Math.floor(i / 8);
        const bitIndex = 7 - (i % 8); // MSB first
        data[byteIndex] |= 1 << bitIndex;
      }
    }

    return { data, dimensions: embedding.length };
  },

  decode(quantized: QuantizedVector): number[] {
    const data = quantized.data as Buffer;
    const dimensions = quantized.dimensions!;
    const result = new Array<number>(dimensions);

    for (let i = 0; i < dimensions; i++) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = 7 - (i % 8); // MSB first
      const bit = (data[byteIndex] >> bitIndex) & 1;
      result[i] = bit === 1 ? 1.0 : -1.0;
    }

    return result;
  },
};
