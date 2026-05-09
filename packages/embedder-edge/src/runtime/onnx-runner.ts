// Lazy ONNX session loader and inference wrapper.
//
// `onnxruntime-node` ships native prebuilds and is the only runtime
// dependency of this package. Sessions are loaded on first use and reused
// for the lifetime of the embedder.

import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
import { loadTokenizer, type Tokenizer } from './tokenizer.js';
import { meanPoolAndNormalize } from './pooling.js';

export interface ModelSpec {
  id: string;
  weightVersion: string;
  dimensions: number;
  maxTokens: number;
  /** Filename of the ONNX file inside the model directory (relative path). */
  onnxFile: string;
}

export interface OnnxSession {
  session: ort.InferenceSession;
  tokenizer: Tokenizer;
  spec: ModelSpec;
}

/**
 * Load an ONNX session and the matching tokenizer from a model directory.
 * The directory must contain `tokenizer.json` and the ONNX file named by
 * `spec.onnxFile`.
 */
export async function loadOnnxSession(modelDir: string, spec: ModelSpec): Promise<OnnxSession> {
  const session = await ort.InferenceSession.create(join(modelDir, spec.onnxFile));
  const tokenizer = await loadTokenizer(join(modelDir, 'tokenizer.json'));
  return { session, tokenizer, spec };
}

/**
 * Run inference over a batch of inputs and return one normalized embedding
 * per input.
 */
export async function runInference(s: OnnxSession, inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return [];

  const encoded = s.tokenizer.encodeBatch(inputs, { maxLength: s.spec.maxTokens });
  const dims = [encoded.batchSize, encoded.length];
  const feeds: Record<string, ort.Tensor> = {
    input_ids: new ort.Tensor('int64', encoded.inputIds, dims),
    attention_mask: new ort.Tensor('int64', encoded.attentionMask, dims),
    token_type_ids: new ort.Tensor('int64', encoded.tokenTypeIds, dims),
  };

  const outputs = await s.session.run(feeds);
  const hidden = outputs.last_hidden_state ?? outputs[Object.keys(outputs)[0]];
  if (!hidden || hidden.type !== 'float32') {
    throw new Error(
      `Unexpected ONNX output: expected float32 last_hidden_state, got ${hidden?.type ?? 'undefined'}`,
    );
  }

  return meanPoolAndNormalize({
    hiddenStates: hidden.data as Float32Array,
    attentionMask: encoded.attentionMask,
    batchSize: encoded.batchSize,
    seqLength: encoded.length,
    dimensions: s.spec.dimensions,
  });
}
