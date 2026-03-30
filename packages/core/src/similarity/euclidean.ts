import type { QuantizedVector, SimilarityFn } from '../types.js';

export const euclideanSimilarity: SimilarityFn = (a: QuantizedVector, b: QuantizedVector): number => {
  const aData = a.data as Float64Array | Int8Array;
  const bData = b.data as Float64Array | Int8Array;
  const len = aData.length;

  let sumSq = 0;

  for (let i = 0; i < len; i++) {
    const diff = aData[i] - bData[i];
    sumSq += diff * diff;
  }

  return 1 / (1 + Math.sqrt(sumSq));
};
