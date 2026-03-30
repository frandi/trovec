import type { QuantizationCodec, QuantizedVector } from '../types.js';

export const f32Codec: QuantizationCodec = {
  type: 'F32',

  encode(embedding: number[]): QuantizedVector {
    return { data: Float64Array.from(embedding) };
  },

  decode(quantized: QuantizedVector): number[] {
    return Array.from(quantized.data as Float64Array);
  },
};
