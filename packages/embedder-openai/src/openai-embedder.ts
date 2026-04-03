import type { Embedder, EmbedResult } from '@trovec/core';

/** Configuration options for the OpenAI embedder. */
export interface OpenAIEmbedderOptions {
  /** OpenAI API key. Required. */
  apiKey: string;
  /**
   * Model identifier to use for embeddings.
   * @defaultValue `"text-embedding-3-small"`
   */
  model?: string;
  /**
   * Base URL for the OpenAI API. Useful for proxies or compatible APIs.
   * @defaultValue `"https://api.openai.com/v1"`
   */
  baseUrl?: string;
  /**
   * Number of dimensions for the output embeddings.
   * Auto-detected for known models (`text-embedding-3-small`: 1536,
   * `text-embedding-3-large`: 3072, `text-embedding-ada-002`: 1536).
   * Required for custom or unknown models.
   */
  dimensions?: number;
}

const MODEL_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

interface OpenAIEmbeddingResponse {
  object: string;
  data: Array<{
    object: string;
    index: number;
    embedding: number[];
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIErrorResponse {
  error: {
    message: string;
    type: string;
    code: string;
  };
}

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * Create an {@link Embedder} backed by the OpenAI Embeddings API.
 *
 * @param options - API key, model, and optional base URL / dimensions override.
 * @returns An {@link Embedder} that calls the OpenAI `/v1/embeddings` endpoint.
 * @throws {Error} If `apiKey` is missing or the model's dimensions cannot be determined.
 *
 * @example
 * ```ts
 * import { createOpenAIEmbedder } from '@trovec/embedder-openai';
 *
 * const embedder = createOpenAIEmbedder({ apiKey: process.env.OPENAI_API_KEY! });
 * const db = await create({ embedder, storageDriver: createFileDriver() });
 * ```
 */
export function createOpenAIEmbedder(options: OpenAIEmbedderOptions): Embedder {
  if (!options.apiKey) {
    throw new Error('OpenAI API key is required');
  }

  const model = options.model ?? DEFAULT_MODEL;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

  const resolvedDimensions = options.dimensions ?? MODEL_DIMENSIONS[model];
  if (resolvedDimensions == null) {
    throw new Error(
      `Unknown model "${model}": dimensions could not be determined. ` +
      'Pass an explicit dimensions option, e.g. createOpenAIEmbedder({ apiKey, model, dimensions: 1536 }).'
    );
  }

  async function callAPI(input: string | string[]): Promise<OpenAIEmbeddingResponse> {
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({ input, model }),
    });

    if (!response.ok) {
      let errorMessage = `OpenAI API error: ${response.status} ${response.statusText}`;
      try {
        const errorBody = await response.json() as OpenAIErrorResponse;
        if (errorBody.error?.message) {
          errorMessage = `OpenAI API error: ${errorBody.error.message}`;
        }
      } catch {
        // Use the default error message
      }
      throw new Error(errorMessage);
    }

    return await response.json() as OpenAIEmbeddingResponse;
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
      return { embedding: response.data[0].embedding };
    },

    async embedMany(inputs: string[]): Promise<EmbedResult[]> {
      if (inputs.length === 0) return [];

      const response = await callAPI(inputs);

      // Sort by index to ensure correct ordering
      const sorted = response.data.sort((a, b) => a.index - b.index);
      return sorted.map((item) => ({ embedding: item.embedding }));
    },
  };
}
