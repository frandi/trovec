import type { Embedder, EmbedResult } from '@trovec/core';

/** Configuration options for the Ollama embedder. */
export interface OllamaEmbedderOptions {
  /**
   * Model identifier to use for embeddings.
   * @defaultValue `"nomic-embed-text"`
   */
  model?: string;
  /**
   * Base URL for the Ollama API.
   * @defaultValue `"http://localhost:11434"`
   */
  baseUrl?: string;
  /**
   * Number of dimensions for the output embeddings.
   * Auto-detected for known models (`nomic-embed-text`: 768,
   * `mxbai-embed-large`: 1024, `all-minilm`: 384, `snowflake-arctic-embed`: 1024).
   * Required for custom or unknown models.
   */
  dimensions?: number;
}

const MODEL_DIMENSIONS: Record<string, number> = {
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
  'all-minilm': 384,
  'snowflake-arctic-embed': 1024,
};

interface OllamaEmbedResponse {
  model: string;
  embeddings: number[][];
}

interface OllamaErrorResponse {
  error: string;
}

const DEFAULT_MODEL = 'nomic-embed-text';
const DEFAULT_BASE_URL = 'http://localhost:11434';

/**
 * Create an {@link Embedder} backed by a local Ollama instance.
 *
 * @param options - Model, base URL, and optional dimensions override. All fields are optional.
 * @returns An {@link Embedder} that calls the Ollama `/api/embed` endpoint.
 * @throws {Error} If the model's dimensions cannot be determined.
 *
 * @example
 * ```ts
 * import { createOllamaEmbedder } from '@trovec/embedder-ollama';
 *
 * const embedder = createOllamaEmbedder({ model: 'nomic-embed-text' });
 * const db = await create({ embedder, storageDriver: createFileDriver() });
 * ```
 */
export function createOllamaEmbedder(options?: OllamaEmbedderOptions): Embedder {
  const model = options?.model ?? DEFAULT_MODEL;
  const baseUrl = (options?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

  const resolvedDimensions = options?.dimensions ?? MODEL_DIMENSIONS[model];
  if (resolvedDimensions == null) {
    throw new Error(
      `Unknown model "${model}": dimensions could not be determined. ` +
      'Pass an explicit dimensions option, e.g. createOllamaEmbedder({ model, dimensions: 768 }).'
    );
  }

  async function callAPI(input: string | string[]): Promise<OllamaEmbedResponse> {
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, input }),
    });

    if (!response.ok) {
      let errorMessage = `Ollama API error: ${response.status} ${response.statusText}`;
      try {
        const errorBody = await response.json() as OllamaErrorResponse;
        if (errorBody.error) {
          errorMessage = `Ollama API error: ${errorBody.error}`;
        }
      } catch {
        // Use the default error message
      }
      throw new Error(errorMessage);
    }

    return await response.json() as OllamaEmbedResponse;
  }

  return {
    get dimensions() {
      return resolvedDimensions;
    },

    get model() {
      return model;
    },

    async embed(input: string): Promise<EmbedResult> {
      const response = await callAPI(input);
      return { embedding: response.embeddings[0] };
    },

    async embedMany(inputs: string[]): Promise<EmbedResult[]> {
      if (inputs.length === 0) return [];

      const response = await callAPI(inputs);
      return response.embeddings.map((embedding) => ({ embedding }));
    },
  };
}
