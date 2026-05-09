// Mean pooling + L2 normalization over `last_hidden_state` outputs.
//
// `last_hidden_state` shape from the ONNX model: [batch, seq, dim], flattened
// row-major (TypedArray). The attention mask (shape [batch, seq]) is used to
// exclude padding positions from the mean.
//
// This matches the post-processing applied by the bge family and is the
// standard choice for sentence-transformers-style retrieval models.

export interface PoolingInputs {
  /** Flattened `last_hidden_state` from ONNX, length = batch * seq * dim. */
  hiddenStates: Float32Array;
  /** Flattened attention mask (1n for real, 0n for padding), length = batch * seq. */
  attentionMask: BigInt64Array;
  batchSize: number;
  seqLength: number;
  dimensions: number;
}

/**
 * Mean-pool the hidden states using the attention mask, then L2-normalize each
 * resulting vector. Returns one `number[]` per input in the batch.
 */
export function meanPoolAndNormalize(input: PoolingInputs): number[][] {
  const { hiddenStates, attentionMask, batchSize, seqLength, dimensions } = input;
  const out: number[][] = [];

  for (let b = 0; b < batchSize; b++) {
    const vec = new Array<number>(dimensions).fill(0);
    let count = 0;
    for (let t = 0; t < seqLength; t++) {
      const mask = Number(attentionMask[b * seqLength + t]);
      if (mask === 0) continue;
      count += 1;
      const hsOffset = (b * seqLength + t) * dimensions;
      for (let d = 0; d < dimensions; d++) {
        vec[d] += hiddenStates[hsOffset + d];
      }
    }
    if (count > 0) {
      const inv = 1 / count;
      for (let d = 0; d < dimensions; d++) vec[d] *= inv;
    }

    // L2 normalize. If a degenerate all-zero vector slips through (e.g. an
    // input that produced only padding), leave it as zeros — downstream
    // similarity will simply score it as 0 against everything.
    let norm = 0;
    for (let d = 0; d < dimensions; d++) norm += vec[d] * vec[d];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      const inv = 1 / norm;
      for (let d = 0; d < dimensions; d++) vec[d] *= inv;
    }

    out.push(vec);
  }

  return out;
}
