import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Embedder, EmbedResult } from '@trovec/core';
import { loadOnnxSession, runInference, type OnnxSession } from './runtime/onnx-runner.js';
import type { Tokenizer } from './runtime/tokenizer.js';
import { resolveModel, type KnownModel } from './model-registry.js';

export type { KnownModel } from './model-registry.js';

// This package is ESM-only (Node 18+).
const __filename = fileURLToPath(import.meta.url);

/** Configuration options for the edge embedder. */
export interface EdgeEmbedderOptions {
  /**
   * Bundled model identifier.
   * @defaultValue `"bge-small-en-v1.5"`
   */
  model?: KnownModel;
  /**
   * Override the directory containing the model assets (`*.onnx` and
   * `tokenizer.json`). Defaults to the bundled `models/<id>` directory
   * shipped with this package.
   */
  modelPath?: string;
  /**
   * Pre-load the ONNX session on factory creation. By default the session
   * is loaded lazily on the first `embed()` or `embedMany()` call.
   * @defaultValue `false`
   */
  preload?: boolean;
  /**
   * Optional pre-built tokenizer. When provided, the embedder will not
   * auto-load `tokenizer.json` from the model directory. Use this for
   * non-WordPiece tokenizers (e.g., SentencePiece) or custom vocabularies.
   *
   * The tokenizer must produce the standard BERT-style ONNX feeds
   * (`input_ids`, `attention_mask`, `token_type_ids`). Models that require
   * a different ONNX feed structure are not supported through this option
   * alone — those need a custom inference path built from the package's
   * lower-level exports (`loadOnnxSession`, `runInference`).
   */
  tokenizer?: Tokenizer;
}

/**
 * Walk up from this module's location until we find the package root —
 * identified by a `package.json` whose `name` is `@trovec/embedder-edge`.
 * This works in both source layout (`src/edge-embedder.ts`) and built
 * layouts (`dist/esm/...`, `dist/cjs/...`).
 */
function findPackageRoot(): string {
  let dir = dirname(__filename);
  for (let i = 0; i < 6; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string };
        if (pkg.name === '@trovec/embedder-edge') return dir;
      } catch {
        // Fall through and keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'Could not locate @trovec/embedder-edge package root. ' +
    'Pass an explicit `modelPath` to createEdgeEmbedder().',
  );
}

const PACKAGE_ROOT = findPackageRoot();

function defaultBundledPath(modelId: KnownModel): string {
  return resolve(PACKAGE_ROOT, 'models', modelId);
}

/**
 * Create an {@link Embedder} that runs a bundled ONNX model in-process via
 * `onnxruntime-node`. The model and tokenizer are loaded lazily on first use.
 *
 * @example
 * ```ts
 * import { create, addWithText, queryByText } from '@trovec/core';
 * import { createEdgeEmbedder } from '@trovec/embedder-edge';
 *
 * const db = await create({ embedder: createEdgeEmbedder() });
 * await addWithText(db, { id: 'doc1', text: 'cats are curious animals' });
 * const results = await queryByText(db, { text: 'pets and animals' });
 * ```
 */
export function createEdgeEmbedder(options?: EdgeEmbedderOptions): Embedder {
  const modelId = options?.model ?? 'bge-small-en-v1.5';
  const spec = resolveModel(modelId);
  const modelDir = options?.modelPath ?? defaultBundledPath(modelId);

  let sessionPromise: Promise<OnnxSession> | null = null;
  const ensureLoaded = (): Promise<OnnxSession> => {
    sessionPromise ??= loadOnnxSession(modelDir, spec, options?.tokenizer);
    return sessionPromise;
  };

  if (options?.preload) {
    void ensureLoaded();
  }

  return {
    get dimensions() {
      return spec.dimensions;
    },
    get model() {
      return `${spec.id}@${spec.weightVersion}`;
    },
    async embed(input: string): Promise<EmbedResult> {
      const session = await ensureLoaded();
      const [embedding] = await runInference(session, [input]);
      return { embedding };
    },
    async embedMany(inputs: string[]): Promise<EmbedResult[]> {
      if (inputs.length === 0) return [];
      const session = await ensureLoaded();
      const vectors = await runInference(session, inputs);
      return vectors.map((embedding) => ({ embedding }));
    },
  };
}
