import type { QuantizedVector, SimilarityFn } from '../types.js';

export const cosineSimilarity: SimilarityFn = (a: QuantizedVector, b: QuantizedVector): number => {
  const aData = a.data as Float64Array | Int8Array;
  const bData = b.data as Float64Array | Int8Array;
  const len = aData.length;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < len; i++) {
    const ai = aData[i];
    const bi = bData[i];
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return dot / denom;
};
