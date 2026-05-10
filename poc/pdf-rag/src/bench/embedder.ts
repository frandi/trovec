// Composes a Trovec Embedder for an arbitrary BenchModelSpec, using the
// low-level building blocks exported by @trovec/embedder-edge. The
// package's createEdgeEmbedder factory is restricted to the bundled model
// (bge-small-en-v1.5) to keep its KnownModel type strict; here we operate
// outside that registry by going through the lower layer directly.

import {
  loadOnnxSession,
  runInference,
  type OnnxSession,
} from '@trovec/embedder-edge';
import type { Embedder, EmbedResult } from '@trovec/core';
import type { BenchModelSpec } from './models.js';

/**
 * Build an Embedder backed by an arbitrary ONNX model directory. Lazy-loads
 * the session on first use, same shape as the package's createEdgeEmbedder.
 */
export function createBenchEmbedder(spec: BenchModelSpec, modelDir: string): Embedder {
  let sessionPromise: Promise<OnnxSession> | null = null;
  const ensureLoaded = (): Promise<OnnxSession> => {
    sessionPromise ??= loadOnnxSession(modelDir, spec);
    return sessionPromise;
  };

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
