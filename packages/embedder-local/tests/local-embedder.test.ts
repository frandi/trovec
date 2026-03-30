import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLocalEmbedder } from '../src/local-embedder.js';

describe('createLocalEmbedder', () => {
  it('creates embedder with default options', () => {
    const embedder = createLocalEmbedder({ warn: false });
    expect(embedder).toBeDefined();
    expect(typeof embedder.embed).toBe('function');
    expect(typeof embedder.embedMany).toBe('function');
  });

  it('defaults to 64 dimensions', async () => {
    const embedder = createLocalEmbedder({ warn: false });
    const result = await embedder.embed('hello');
    expect(result.embedding).toHaveLength(64);
  });

  it('respects custom dimensions', async () => {
    const embedder = createLocalEmbedder({ dimensions: 128, warn: false });
    const result = await embedder.embed('hello');
    expect(result.embedding).toHaveLength(128);
  });
});

describe('embed', () => {
  it('returns a number array', async () => {
    const embedder = createLocalEmbedder({ warn: false });
    const result = await embedder.embed('hello world');
    expect(Array.isArray(result.embedding)).toBe(true);
    result.embedding.forEach((v) => expect(typeof v).toBe('number'));
  });

  it('produces L2-normalized vectors', async () => {
    const embedder = createLocalEmbedder({ warn: false });
    const result = await embedder.embed('the quick brown fox');
    const norm = Math.sqrt(result.embedding.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it('is deterministic — same input gives same output', async () => {
    const embedder = createLocalEmbedder({ warn: false });
    const a = await embedder.embed('test input');
    const b = await embedder.embed('test input');
    expect(a.embedding).toEqual(b.embedding);
  });

  it('produces different embeddings for different text', async () => {
    const embedder = createLocalEmbedder({ warn: false });
    const a = await embedder.embed('cats are great');
    const b = await embedder.embed('javascript programming');
    expect(a.embedding).not.toEqual(b.embedding);
  });

  it('produces similar embeddings for similar text', async () => {
    const embedder = createLocalEmbedder({ dimensions: 64, warn: false });
    const a = await embedder.embed('cats are cute animals');
    const b = await embedder.embed('cats are adorable animals');
    const c = await embedder.embed('database query optimization');

    // cosine similarity helper
    function cosine(x: number[], y: number[]): number {
      let dot = 0, nA = 0, nB = 0;
      for (let i = 0; i < x.length; i++) {
        dot += x[i] * y[i];
        nA += x[i] * x[i];
        nB += y[i] * y[i];
      }
      const denom = Math.sqrt(nA) * Math.sqrt(nB);
      return denom === 0 ? 0 : dot / denom;
    }

    const simAB = cosine(a.embedding, b.embedding);
    const simAC = cosine(a.embedding, c.embedding);

    // Similar text should be closer than dissimilar text
    expect(simAB).toBeGreaterThan(simAC);
  });

  it('handles empty string', async () => {
    const embedder = createLocalEmbedder({ warn: false });
    const result = await embedder.embed('');
    expect(result.embedding).toHaveLength(64);
    // All zeros for empty input (no features to hash)
    expect(result.embedding.every((v) => v === 0)).toBe(true);
  });

  it('handles single character', async () => {
    const embedder = createLocalEmbedder({ warn: false });
    const result = await embedder.embed('a');
    expect(result.embedding).toHaveLength(64);
  });
});

describe('embedMany', () => {
  it('returns correct number of results', async () => {
    const embedder = createLocalEmbedder({ warn: false });
    const results = await embedder.embedMany(['hello', 'world', 'test']);
    expect(results).toHaveLength(3);
  });

  it('returns empty array for empty input', async () => {
    const embedder = createLocalEmbedder({ warn: false });
    const results = await embedder.embedMany([]);
    expect(results).toEqual([]);
  });

  it('matches individual embed results', async () => {
    const embedder = createLocalEmbedder({ warn: false });
    const batch = await embedder.embedMany(['hello', 'world']);
    const single1 = await embedder.embed('hello');
    const single2 = await embedder.embed('world');
    expect(batch[0].embedding).toEqual(single1.embedding);
    expect(batch[1].embedding).toEqual(single2.embedding);
  });
});

describe('warning', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('prints warning on first use by default', async () => {
    const embedder = createLocalEmbedder();
    await embedder.embed('test');
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('prototyping and testing only');
  });

  it('prints warning only once', async () => {
    const embedder = createLocalEmbedder();
    await embedder.embed('first');
    await embedder.embed('second');
    await embedder.embedMany(['third']);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('suppresses warning when warn: false', async () => {
    const embedder = createLocalEmbedder({ warn: false });
    await embedder.embed('test');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
