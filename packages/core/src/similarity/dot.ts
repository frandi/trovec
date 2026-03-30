import type { QuantizedVector, SimilarityFn } from '../types.js';

export const dotSimilarity: SimilarityFn = (a: QuantizedVector, b: QuantizedVector): number => {
  const aData = a.data as Float64Array | Int8Array;
  const bData = b.data as Float64Array | Int8Array;
  const len = aData.length;

  let sum = 0;

  for (let i = 0; i < len; i++) {
    sum += aData[i] * bData[i];
  }

  return sum;
};
