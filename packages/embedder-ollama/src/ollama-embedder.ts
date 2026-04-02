import type { Embedder, EmbedResult } from '@trovec/core';

export interface OllamaEmbedderOptions {
  model?: string;
  baseUrl?: string;
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
