import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOpenAIEmbedder } from '../src/openai-embedder.js';

function mockFetchResponse(data: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
  });
}

function makeEmbeddingResponse(embeddings: number[][]) {
  return {
    object: 'list',
    data: embeddings.map((embedding, index) => ({
      object: 'embedding',
      index,
      embedding,
    })),
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: 10, total_tokens: 10 },
  };
}

describe('createOpenAIEmbedder', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('throws if apiKey is missing', () => {
    expect(() => createOpenAIEmbedder({ apiKey: '' })).toThrow('API key is required');
  });

  it('creates embedder with valid options', () => {
    const embedder = createOpenAIEmbedder({ apiKey: 'sk-test' });
    expect(embedder).toBeDefined();
    expect(typeof embedder.embed).toBe('function');
    expect(typeof embedder.embedMany).toBe('function');
  });

  it('exposes dimensions for default model', () => {
    const embedder = createOpenAIEmbedder({ apiKey: 'sk-test' });
    expect(embedder.dimensions).toBe(1536);
  });

  it('exposes default model name', () => {
    const embedder = createOpenAIEmbedder({ apiKey: 'sk-test' });
    expect(embedder.model).toBe('text-embedding-3-small');
  });

  it('exposes custom model name', () => {
    const embedder = createOpenAIEmbedder({ apiKey: 'sk-test', model: 'text-embedding-3-large' });
    expect(embedder.model).toBe('text-embedding-3-large');
  });

  it('exposes dimensions for text-embedding-3-large', () => {
    const embedder = createOpenAIEmbedder({ apiKey: 'sk-test', model: 'text-embedding-3-large' });
    expect(embedder.dimensions).toBe(3072);
  });

  it('uses explicit dimensions for unknown model', () => {
    const embedder = createOpenAIEmbedder({ apiKey: 'sk-test', model: 'custom-model', dimensions: 2048 });
    expect(embedder.dimensions).toBe(2048);
  });

  it('throws for unknown model without explicit dimensions', () => {
    expect(() => createOpenAIEmbedder({ apiKey: 'sk-test', model: 'unknown-model' }))
      .toThrow('Unknown model "unknown-model"');
  });
});

describe('embed', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls OpenAI API and returns embedding', async () => {
    const mockEmbedding = [0.1, 0.2, 0.3];
    globalThis.fetch = mockFetchResponse(makeEmbeddingResponse([mockEmbedding]));

    const embedder = createOpenAIEmbedder({ apiKey: 'sk-test' });
    const result = await embedder.embed('hello world');

    expect(result.embedding).toEqual(mockEmbedding);
    expect(globalThis.fetch).toHaveBeenCalledOnce();

    const callArgs = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(callArgs[0]).toBe('https://api.openai.com/v1/embeddings');

    const requestInit = callArgs[1] as RequestInit;
    expect(requestInit.method).toBe('POST');
    expect(requestInit.headers).toEqual({
      'Content-Type': 'application/json',
      'Authorization': 'Bearer sk-test',
    });

    const body = JSON.parse(requestInit.body as string);
    expect(body.input).toBe('hello world');
    expect(body.model).toBe('text-embedding-3-small');
  });

  it('uses custom model', async () => {
    globalThis.fetch = mockFetchResponse(makeEmbeddingResponse([[0.1]]));

    const embedder = createOpenAIEmbedder({ apiKey: 'sk-test', model: 'text-embedding-3-large' });
    await embedder.embed('test');

    const body = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe('text-embedding-3-large');
  });

  it('uses custom baseUrl', async () => {
    globalThis.fetch = mockFetchResponse(makeEmbeddingResponse([[0.1]]));

    const embedder = createOpenAIEmbedder({ apiKey: 'sk-test', baseUrl: 'https://my-proxy.com/v1' });
    await embedder.embed('test');

    const url = vi.mocked(globalThis.fetch).mock.calls[0][0];
    expect(url).toBe('https://my-proxy.com/v1/embeddings');
  });

  it('strips trailing slashes from baseUrl', async () => {
    globalThis.fetch = mockFetchResponse(makeEmbeddingResponse([[0.1]]));

    const embedder = createOpenAIEmbedder({ apiKey: 'sk-test', baseUrl: 'https://my-proxy.com/v1/' });
    await embedder.embed('test');

    const url = vi.mocked(globalThis.fetch).mock.calls[0][0];
    expect(url).toBe('https://my-proxy.com/v1/embeddings');
  });

  it('throws on API error with error message', async () => {
    globalThis.fetch = mockFetchResponse(
      { error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' } },
      401,
    );

    const embedder = createOpenAIEmbedder({ apiKey: 'sk-bad' });
    await expect(embedder.embed('test')).rejects.toThrow('OpenAI API error: Invalid API key');
  });

  it('throws on API error with status when no body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: () => Promise.reject(new Error('no json')),
    });

    const embedder = createOpenAIEmbedder({ apiKey: 'sk-test' });
    await expect(embedder.embed('test')).rejects.toThrow('OpenAI API error: 500 Internal Server Error');
  });
});

describe('embedMany', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns empty array for empty input', async () => {
    const embedder = createOpenAIEmbedder({ apiKey: 'sk-test' });
    const results = await embedder.embedMany([]);
    expect(results).toEqual([]);
  });

  it('sends batch request and returns ordered results', async () => {
    const embeddings = [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]];
    globalThis.fetch = mockFetchResponse(makeEmbeddingResponse(embeddings));

    const embedder = createOpenAIEmbedder({ apiKey: 'sk-test' });
    const results = await embedder.embedMany(['a', 'b', 'c']);

    expect(results).toHaveLength(3);
    expect(results[0].embedding).toEqual([0.1, 0.2]);
    expect(results[1].embedding).toEqual([0.3, 0.4]);
    expect(results[2].embedding).toEqual([0.5, 0.6]);

    // Verify batch request was sent
    const body = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.input).toEqual(['a', 'b', 'c']);
  });

  it('sorts results by index even if API returns out of order', async () => {
    // API returns indices out of order
    globalThis.fetch = mockFetchResponse({
      object: 'list',
      data: [
        { object: 'embedding', index: 2, embedding: [0.5, 0.6] },
        { object: 'embedding', index: 0, embedding: [0.1, 0.2] },
        { object: 'embedding', index: 1, embedding: [0.3, 0.4] },
      ],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 10, total_tokens: 10 },
    });

    const embedder = createOpenAIEmbedder({ apiKey: 'sk-test' });
    const results = await embedder.embedMany(['a', 'b', 'c']);

    expect(results[0].embedding).toEqual([0.1, 0.2]);
    expect(results[1].embedding).toEqual([0.3, 0.4]);
    expect(results[2].embedding).toEqual([0.5, 0.6]);
  });
});
