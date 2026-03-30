import type { QuantizedVector, SimilarityFn } from '../types.js';

// Popcount lookup table for bytes 0-255
const POPCOUNT_TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  POPCOUNT_TABLE[i] = POPCOUNT_TABLE[i >> 1] + (i & 1);
}

export const hammingSimilarity: SimilarityFn = (a: QuantizedVector, b: QuantizedVector): number => {
  const aData = a.data as Buffer;
  const bData = b.data as Buffer;
  const totalBits = a.dimensions!;
  const byteCount = aData.length;

  let matchingBits = 0;

  for (let i = 0; i < byteCount; i++) {
    const xor = aData[i] ^ bData[i];
    // Count differing bits, then subtract from 8 to get matching
    matchingBits += 8 - POPCOUNT_TABLE[xor];
  }

  // Subtract padding bits that were counted as matching
  const paddingBits = byteCount * 8 - totalBits;
  matchingBits -= paddingBits;

  return matchingBits / totalBits;
};
