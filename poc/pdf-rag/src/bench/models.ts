// Benchmark-only model registry. These models are downloaded into
// poc/pdf-rag/bench-models/<id>/ on demand (gitignored) and used by the
// benchmark script to compare quality vs size vs latency vs cloud.
//
// They are NOT bundled with @trovec/embedder-edge. The package ships only
// bge-small-en-v1.5; everything else here is for benchmarking.

import type { ModelSpec } from '@trovec/embedder-edge';

export type Tier = 'small' | 'base' | 'large' | 'cloud';

export interface BenchModelSpec extends ModelSpec {
  /** HuggingFace repo, e.g. 'Xenova/bge-small-en-v1.5'. */
  hfRepo: string;
  /** Pinned commit SHA on HuggingFace. */
  hfRevision: string;
  /** Files we need to download for this model (relative to repo root). */
  hfFiles: string[];
  /** Approximate ONNX file size in MB, for reporting. */
  approxOnnxMb: number;
  /** Tier label for the report's recommendation matrix. */
  tier: Tier;
  /** Human-readable label for the report. */
  label: string;
}

const COMMON_FILES = ['tokenizer.json', 'config.json', 'tokenizer_config.json', 'special_tokens_map.json'];

export const BENCH_MODELS: BenchModelSpec[] = [
  {
    id: 'bge-small-en-v1.5',
    label: 'bge-small-en-v1.5 INT8',
    weightVersion: '1.0.0',
    dimensions: 384,
    maxTokens: 512,
    onnxFile: 'onnx/model_int8.onnx',
    hfRepo: 'Xenova/bge-small-en-v1.5',
    hfRevision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
    hfFiles: ['onnx/model_int8.onnx', ...COMMON_FILES],
    approxOnnxMb: 32,
    tier: 'small',
  },
  {
    id: 'all-MiniLM-L6-v2',
    label: 'all-MiniLM-L6-v2 INT8',
    weightVersion: '1.0.0',
    dimensions: 384,
    maxTokens: 256,
    onnxFile: 'onnx/model_int8.onnx',
    hfRepo: 'Xenova/all-MiniLM-L6-v2',
    hfRevision: '751bff37182d3f1213fa05d7196b954e230abad9',
    hfFiles: ['onnx/model_int8.onnx', ...COMMON_FILES],
    approxOnnxMb: 23,
    tier: 'small',
  },
  {
    id: 'bge-base-en-v1.5',
    label: 'bge-base-en-v1.5 INT8',
    weightVersion: '1.0.0',
    dimensions: 768,
    maxTokens: 512,
    onnxFile: 'onnx/model_int8.onnx',
    hfRepo: 'Xenova/bge-base-en-v1.5',
    hfRevision: '4d6cd88e18e51a5e020c2c305726d76ada9c03cf',
    hfFiles: ['onnx/model_int8.onnx', ...COMMON_FILES],
    approxOnnxMb: 110,
    tier: 'base',
  },
  {
    id: 'bge-large-en-v1.5',
    label: 'bge-large-en-v1.5 INT8',
    weightVersion: '1.0.0',
    dimensions: 1024,
    maxTokens: 512,
    onnxFile: 'onnx/model_int8.onnx',
    hfRepo: 'Xenova/bge-large-en-v1.5',
    hfRevision: 'dfeef6070b90658e1b391a6940efdb0925c1de6f',
    hfFiles: ['onnx/model_int8.onnx', ...COMMON_FILES],
    approxOnnxMb: 336,
    tier: 'large',
  },
];
