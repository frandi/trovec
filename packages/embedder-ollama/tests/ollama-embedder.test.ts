import { describe, it, expect, vi, afterEach } from 'vitest';
import { createOllamaEmbedder } from '../src/ollama-embedder.js';

function mockFetchResponse(data: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
  });
}

function makeEmbedResponse(embeddings: number[][]) {
  return {
    model: 'nomic-embed-text',
    embeddings,
  };
}

describe('createOllamaEmbedder', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('creates embedder with default options', () => {
    const embedder = createOllamaEmbedder();
    expect(embedder).toBeDefined();
    expect(typeof embedder.embed).toBe('function');
    expect(typeof embedder.embedMany).toBe('function');
  });

  it('creates embedder with custom options', () => {
    const embedder = createOllamaEmbedder({
      model: 'mxbai-embed-large',
      baseUrl: 'http://remote-host:11434',
    });
    expect(embedder).toBeDefined();
  });

  it('exposes dimensions for default model', () => {
    const embedder = createOllamaEmbedder();
    expect(embedder.dimensions).toBe(768);
  });

  it('exposes dimensions for mxbai-embed-large', () => {
    const embedder = createOllamaEmbedder({ model: 'mxbai-embed-large' });
    expect(embedder.dimensions).toBe(1024);
  });

  it('uses explicit dimensions for unknown model', () => {
    const embedder = createOllamaEmbedder({ model: 'custom-model', dimensions: 512 });
    expect(embedder.dimensions).toBe(512);
  });

  it('throws for unknown model without explicit dimensions', () => {
    expect(() => createOllamaEmbedder({ model: 'unknown-model' }))
      .toThrow('Unknown model "unknown-model"');
  });
});

describe('embed', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls Ollama API and returns embedding', async () => {
    const mockEmbedding = [0.1, 0.2, 0.3];
    globalThis.fetch = mockFetchResponse(makeEmbedResponse([mockEmbedding]));

    const embedder = createOllamaEmbedder();
    const result = await embedder.embed('hello world');

    expect(result.embedding).toEqual(mockEmbedding);
    expect(globalThis.fetch).toHaveBeenCalledOnce();

    const callArgs = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(callArgs[0]).toBe('http://localhost:11434/api/embed');

    const requestInit = callArgs[1] as RequestInit;
    expect(requestInit.method).toBe('POST');
    expect(requestInit.headers).toEqual({
      'Content-Type': 'application/json',
    });

    const body = JSON.parse(requestInit.body as string);
    expect(body.input).toBe('hello world');
    expect(body.model).toBe('nomic-embed-text');
  });

  it('uses custom model', async () => {
    globalThis.fetch = mockFetchResponse(makeEmbedResponse([[0.1]]));

    const embedder = createOllamaEmbedder({ model: 'mxbai-embed-large' });
    await embedder.embed('test');

    const body = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe('mxbai-embed-large');
  });

  it('uses custom baseUrl', async () => {
    globalThis.fetch = mockFetchResponse(makeEmbedResponse([[0.1]]));

    const embedder = createOllamaEmbedder({ baseUrl: 'http://remote-host:11434' });
    await embedder.embed('test');

    const url = vi.mocked(globalThis.fetch).mock.calls[0][0];
    expect(url).toBe('http://remote-host:11434/api/embed');
  });

  it('strips trailing slashes from baseUrl', async () => {
    globalThis.fetch = mockFetchResponse(makeEmbedResponse([[0.1]]));

    const embedder = createOllamaEmbedder({ baseUrl: 'http://remote-host:11434/' });
    await embedder.embed('test');

    const url = vi.mocked(globalThis.fetch).mock.calls[0][0];
    expect(url).toBe('http://remote-host:11434/api/embed');
  });

  it('throws on API error with error message', async () => {
    globalThis.fetch = mockFetchResponse(
      { error: 'model "bad-model" not found' },
      404,
    );

    const embedder = createOllamaEmbedder({ model: 'bad-model', dimensions: 768 });
    await expect(embedder.embed('test')).rejects.toThrow('Ollama API error: model "bad-model" not found');
  });

  it('throws on API error with status when no body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: () => Promise.reject(new Error('no json')),
    });

    const embedder = createOllamaEmbedder();
    await expect(embedder.embed('test')).rejects.toThrow('Ollama API error: 500 Internal Server Error');
  });
});

describe('embedMany', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns empty array for empty input', async () => {
    const embedder = createOllamaEmbedder();
    const results = await embedder.embedMany([]);
    expect(results).toEqual([]);
  });

  it('sends batch request and returns ordered results', async () => {
    const embeddings = [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]];
    globalThis.fetch = mockFetchResponse(makeEmbedResponse(embeddings));

    const embedder = createOllamaEmbedder();
    const results = await embedder.embedMany(['a', 'b', 'c']);

    expect(results).toHaveLength(3);
    expect(results[0].embedding).toEqual([0.1, 0.2]);
    expect(results[1].embedding).toEqual([0.3, 0.4]);
    expect(results[2].embedding).toEqual([0.5, 0.6]);

    // Verify batch request was sent
    const body = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.input).toEqual(['a', 'b', 'c']);
  });
});
