// Static registry of bundled models known to @trovec/embedder-edge.
//
// `weightVersion` is bumped when the bundled ONNX file changes. It feeds
// into `Embedder.model` as `<id>@<weightVersion>` so the v2.3.0 identity
// tracking in @trovec/core can flag mismatches against persisted vectors.
// The package version (in package.json) is independent — bumping the package
// for unrelated reasons does not bump the weight version.

import type { ModelSpec } from './runtime/onnx-runner.js';

export type KnownModel = 'bge-small-en-v1.5' | 'bge-base-en-v1.5';

export const MODELS: Record<KnownModel, ModelSpec> = {
  'bge-small-en-v1.5': {
    id: 'bge-small-en-v1.5',
    weightVersion: '1.0.0',
    dimensions: 384,
    maxTokens: 512,
    onnxFile: 'onnx/model_int8.onnx',
  },
  // Not bundled with the package — callers must provide `modelPath` pointing
  // at a directory containing `onnx/model_int8.onnx` and `tokenizer.json`.
  'bge-base-en-v1.5': {
    id: 'bge-base-en-v1.5',
    weightVersion: '1.0.0',
    dimensions: 768,
    maxTokens: 512,
    onnxFile: 'onnx/model_int8.onnx',
  },
};

export function resolveModel(id: KnownModel): ModelSpec {
  const spec = MODELS[id];
  if (!spec) {
    const available = Object.keys(MODELS).join(', ');
    throw new Error(`Unknown model "${id}". Available models: ${available}`);
  }
  return spec;
}
