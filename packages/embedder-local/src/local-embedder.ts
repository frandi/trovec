/**
 * A zero-dependency local text embedder for Trovec.
 *
 * Generates deterministic embeddings from text using character n-gram hashing
 * with L2 normalization. Runs entirely in-process — no API calls, no model files,
 * no setup required.
 *
 * ⚠️  NOT RECOMMENDED FOR PRODUCTION USE.
 * This embedder uses a simple hashing strategy that does not capture true semantic
 * meaning. For production applications, use a real embedding model (OpenAI, Ollama,
 * Sentence Transformers, etc.).
 *
 * Good for: prototyping, testing, CI, demos, learning the Trovec API.
 */
import type { Embedder, EmbedResult } from '@trovec/core';

/** Configuration options for the local hash-based embedder. */
export interface LocalEmbedderOptions {
  /**
   * Number of dimensions for output embeddings.
   * @default 64
   */
  dimensions?: number;

  /**
   * Print a warning to stderr on first use.
   * Set to `false` to suppress.
   * @default true
   */
  warn?: boolean;
}

function hashString(str: string, seed: number): number {
  let h = seed;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 0x5bd1e995);
    h ^= h >>> 13;
  }
  return h;
}

function textToEmbedding(text: string, dimensions: number): number[] {
  const normalized = text.toLowerCase().trim();
  const embedding = new Float64Array(dimensions);

  const tokens = normalized.split(/\s+/).filter(Boolean);

  for (const token of tokens) {
    // Character trigrams
    for (let i = 0; i <= token.length - 3; i++) {
      const trigram = token.slice(i, i + 3);
      const hash = hashString(trigram, 42);
      const idx = Math.abs(hash) % dimensions;
      const sign = hash > 0 ? 1 : -1;
      embedding[idx] += sign * 0.1;
    }

    // Character bigrams
    for (let i = 0; i <= token.length - 2; i++) {
      const bigram = token.slice(i, i + 2);
      const hash = hashString(bigram, 97);
      const idx = Math.abs(hash) % dimensions;
      const sign = hash > 0 ? 1 : -1;
      embedding[idx] += sign * 0.05;
    }

    // Whole-token feature
    const tokenHash = hashString(token, 7);
    const tokenIdx = Math.abs(tokenHash) % dimensions;
    embedding[tokenIdx] += 0.3;
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dimensions; i++) {
    norm += embedding[i] * embedding[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dimensions; i++) {
      embedding[i] /= norm;
    }
  }

  return Array.from(embedding);
}

const WARNING =
  '[@trovec/embedder-local] This embedder uses simple text hashing, not a real ML model. ' +
  'It is intended for prototyping and testing only. ' +
  'For production, use a proper embedding model (e.g., @trovec/embedder-openai).';

/**
 * Create a zero-dependency local {@link Embedder} that uses character n-gram hashing.
 *
 * Generates deterministic embeddings entirely in-process — no API calls or model files.
 * Intended for prototyping, testing, and demos only; does not capture true semantic meaning.
 *
 * @param options - Optional dimensions and warning configuration.
 * @returns An {@link Embedder} that produces hash-based embeddings.
 *
 * @example
 * ```ts
 * import { createLocalEmbedder } from '@trovec/embedder-local';
 *
 * const embedder = createLocalEmbedder({ dimensions: 128 });
 * const db = await create({ embedder });
 * ```
 */
export function createLocalEmbedder(options: LocalEmbedderOptions = {}): Embedder {
  const dimensions = options.dimensions ?? 64;
  const shouldWarn = options.warn ?? true;
  let warned = false;

  function maybeWarn(): void {
    if (shouldWarn && !warned) {
      warned = true;
      console.warn(WARNING);
    }
  }

  return {
    get dimensions() {
      return dimensions;
    },

    async embed(input: string): Promise<EmbedResult> {
      maybeWarn();
      return { embedding: textToEmbedding(input, dimensions) };
    },

    async embedMany(inputs: string[]): Promise<EmbedResult[]> {
      maybeWarn();
      return inputs.map((input) => ({ embedding: textToEmbedding(input, dimensions) }));
    },
  };
}
