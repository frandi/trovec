export { createEdgeEmbedder } from './edge-embedder.js';
export type { EdgeEmbedderOptions, KnownModel } from './edge-embedder.js';

// Low-level building blocks. Exposed so users can compose embedders for
// non-bundled models, plug in custom tokenizers (e.g., SentencePiece), or
// build a custom inference loop. The everyday path is `createEdgeEmbedder`;
// reach for these only when that doesn't fit.

export { createTokenizer, loadTokenizer } from './runtime/tokenizer.js';
export type {
  Tokenizer,
  TokenizerJson,
  EncodeOptions,
  EncodedBatch,
} from './runtime/tokenizer.js';

export { loadOnnxSession, runInference } from './runtime/onnx-runner.js';
export type { ModelSpec, OnnxSession } from './runtime/onnx-runner.js';

export { meanPoolAndNormalize } from './runtime/pooling.js';
export type { PoolingInputs } from './runtime/pooling.js';
