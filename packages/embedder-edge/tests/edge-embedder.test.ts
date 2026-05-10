import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the ONNX runner so factory tests never touch the real model. The
// mock returns deterministic vectors derived from the input length, which
// is enough to assert dimensions, batching, and lazy-load semantics.
vi.mock('../src/runtime/onnx-runner.js', () => {
  return {
    loadOnnxSession: vi.fn(async (modelDir: string, spec: { dimensions: number }) => ({
      __mock: true,
      modelDir,
      spec,
    })),
    runInference: vi.fn(async (session: { spec: { dimensions: number } }, inputs: string[]) => {
      return inputs.map((input) => {
        const v = new Array<number>(session.spec.dimensions).fill(0);
        v[0] = input.length;
        return v;
      });
    }),
  };
});

// Re-import after mocking.
import { createEdgeEmbedder } from '../src/edge-embedder.js';
import { loadOnnxSession, runInference } from '../src/runtime/onnx-runner.js';

const mockedLoad = vi.mocked(loadOnnxSession);
const mockedRun = vi.mocked(runInference);

beforeEach(() => {
  mockedLoad.mockClear();
  mockedRun.mockClear();
});

describe('createEdgeEmbedder', () => {
  it('returns synchronously without loading the model', () => {
    const embedder = createEdgeEmbedder();
    expect(embedder).toBeDefined();
    expect(typeof embedder.embed).toBe('function');
    expect(typeof embedder.embedMany).toBe('function');
    expect(mockedLoad).not.toHaveBeenCalled();
  });

  it('exposes the default model dimensions and identity', () => {
    const embedder = createEdgeEmbedder();
    expect(embedder.dimensions).toBe(384);
    expect(embedder.model).toBe('bge-small-en-v1.5@1.0.0');
  });

  it('exposes a versioned model identity for the v2.3.0 mismatch warning', () => {
    const embedder = createEdgeEmbedder();
    expect(embedder.model).toMatch(/^bge-small-en-v1\.5@\d+\.\d+\.\d+$/);
  });

  it('throws on unknown model id', () => {
    expect(() =>
      createEdgeEmbedder({ model: 'no-such-model' as never }),
    ).toThrow(/Unknown model "no-such-model"/);
  });

  it('passes a custom modelPath through to the loader', async () => {
    const embedder = createEdgeEmbedder({ modelPath: '/tmp/custom-model-dir' });
    await embedder.embed('hello');
    expect(mockedLoad).toHaveBeenCalledTimes(1);
    expect(mockedLoad.mock.calls[0][0]).toBe('/tmp/custom-model-dir');
  });

  it('loads the model eagerly when preload is true', () => {
    createEdgeEmbedder({ preload: true });
    expect(mockedLoad).toHaveBeenCalledTimes(1);
  });

  it('forwards a custom tokenizer through to loadOnnxSession', async () => {
    const customTokenizer = {
      encode: vi.fn(),
      encodeBatch: vi.fn(),
      spec: {} as never,
    };
    const embedder = createEdgeEmbedder({ tokenizer: customTokenizer });
    await embedder.embed('hello');
    expect(mockedLoad).toHaveBeenCalledTimes(1);
    // Third argument is the optional pre-built tokenizer.
    expect(mockedLoad.mock.calls[0][2]).toBe(customTokenizer);
  });

  it('omits the tokenizer argument when none is provided', async () => {
    const embedder = createEdgeEmbedder();
    await embedder.embed('hello');
    expect(mockedLoad).toHaveBeenCalledTimes(1);
    expect(mockedLoad.mock.calls[0][2]).toBeUndefined();
  });
});

describe('embed / embedMany', () => {
  it('lazily triggers exactly one loadOnnxSession across many concurrent calls', async () => {
    const embedder = createEdgeEmbedder();
    await Promise.all([
      embedder.embed('a'),
      embedder.embed('bb'),
      embedder.embedMany(['c', 'dd']),
    ]);
    expect(mockedLoad).toHaveBeenCalledTimes(1);
  });

  it('embed() returns a single embedding of the configured dimensions', async () => {
    const embedder = createEdgeEmbedder();
    const result = await embedder.embed('hello');
    expect(result.embedding).toHaveLength(384);
    // Deterministic mock: index 0 = input length.
    expect(result.embedding[0]).toBe(5);
  });

  it('embedMany([]) returns [] without invoking the runtime', async () => {
    const embedder = createEdgeEmbedder();
    const results = await embedder.embedMany([]);
    expect(results).toEqual([]);
    expect(mockedLoad).not.toHaveBeenCalled();
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('embedMany batches inputs in a single inference call', async () => {
    const embedder = createEdgeEmbedder();
    const results = await embedder.embedMany(['one', 'two', 'three']);
    expect(results).toHaveLength(3);
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(mockedRun.mock.calls[0][1]).toEqual(['one', 'two', 'three']);
  });
});
