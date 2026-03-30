import type { QuantizationCodec, QuantizedVector } from '../types.js';

export const int8Codec: QuantizationCodec = {
  type: 'INT8',

  encode(embedding: number[]): QuantizedVector {
    let min = Infinity;
    let max = -Infinity;

    for (let i = 0; i < embedding.length; i++) {
      if (embedding[i] < min) min = embedding[i];
      if (embedding[i] > max) max = embedding[i];
    }

    const data = new Int8Array(embedding.length);
    const range = max - min;

    if (range === 0) {
      // Constant vector — all values map to 0 (midpoint)
      data.fill(0);
    } else {
      for (let i = 0; i < embedding.length; i++) {
        data[i] = Math.round(((embedding[i] - min) / range) * 255) - 128;
      }
    }

    return { data, min, max };
  },

  decode(quantized: QuantizedVector): number[] {
    const data = quantized.data as Int8Array;
    const min = quantized.min!;
    const max = quantized.max!;
    const range = max - min;
    const result = new Array<number>(data.length);

    if (range === 0) {
      result.fill(min);
    } else {
      for (let i = 0; i < data.length; i++) {
        result[i] = ((data[i] + 128) / 255) * range + min;
      }
    }

    return result;
  },
};
