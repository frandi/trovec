import type { Embedder, EmbedResult } from '@trovec/core';

export interface OpenAIEmbedderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
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
