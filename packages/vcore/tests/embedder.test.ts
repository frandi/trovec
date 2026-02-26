import { describe, it, expect, vi } from 'vitest';
import { create, stats } from '../src/core.js';
import { get } from '../src/collection.js';
import { query } from '../src/query.js';
import { embed, embedMany, addWithText, addManyWithText, queryByText } from '../src/embedder.js';
import type { Embedder } from '../src/types.js';
import { VCoreError } from '../src/errors.js';

function createMockEmbedder(dimensions: number): Embedder {
  return {
    async embed(input: string) {
      // Simple deterministic mock: hash-like embedding based on string
      const embedding = new Array(dimensions).fill(0);
      for (let i = 0; i < input.length; i++) {
        embedding[i % dimensions] += input.charCodeAt(i) / 1000;
      }
      return { embedding };
    },
    async embedMany(inputs: string[]) {
      const results = [];
      for (const input of inputs) {
        results.push(await this.embed(input));
      }
      return results;
    },
  };
}

describe('embed', () => {
  it('delegates to the configured embedder', async () => {
    const mockEmbedder = createMockEmbedder(3);
    const instance = create({ dimensions: 3, embedder: mockEmbedder });

    const result = await embed(instance, 'hello');
    expect(result.embedding).toHaveLength(3);
  });

  it('throws if no embedder is configured', async () => {
    const instance = create({ dimensions: 3 });
    await expect(embed(instance, 'hello')).rejects.toThrow(VCoreError);
    await expect(embed(instance, 'hello')).rejects.toThrow(/No embedder configured/);
  });
});

describe('embedMany', () => {
  it('delegates to the configured embedder', async () => {
    const mockEmbedder = createMockEmbedder(3);
    const instance = create({ dimensions: 3, embedder: mockEmbedder });

    const results = await embedMany(instance, ['hello', 'world']);
    expect(results).toHaveLength(2);
    expect(results[0].embedding).toHaveLength(3);
    expect(results[1].embedding).toHaveLength(3);
  });

  it('throws if no embedder is configured', async () => {
    const instance = create({ dimensions: 3 });
    await expect(embedMany(instance, ['hello'])).rejects.toThrow(VCoreError);
  });
});

describe('addWithText', () => {
  it('embeds text and adds entry', async () => {
    const mockEmbedder = createMockEmbedder(3);
    const instance = create({ dimensions: 3, embedder: mockEmbedder });

    await addWithText(instance, { id: 'doc1', text: 'hello world' });

    const entry = get(instance, 'doc1');
    expect(entry).toBeDefined();
    expect(entry!.embedding).toHaveLength(3);
    expect(stats(instance).entryCount).toBe(1);
  });

  it('preserves context', async () => {
    const mockEmbedder = createMockEmbedder(3);
    const instance = create({ dimensions: 3, embedder: mockEmbedder });

    await addWithText(instance, { id: 'doc1', text: 'hello', context: { source: 'test' } });

    const entry = get(instance, 'doc1');
    expect(entry!.context).toEqual({ source: 'test' });
  });

  it('throws if no embedder is configured', async () => {
    const instance = create({ dimensions: 3 });
    await expect(addWithText(instance, { id: 'doc1', text: 'hello' })).rejects.toThrow(VCoreError);
  });
});

describe('addManyWithText', () => {
  it('embeds and batch inserts multiple entries', async () => {
    const mockEmbedder = createMockEmbedder(3);
    const instance = create({ dimensions: 3, embedder: mockEmbedder });

    await addManyWithText(instance, [
      { id: 'doc1', text: 'hello world' },
      { id: 'doc2', text: 'foo bar', context: { tag: 'test' } },
    ]);

    expect(stats(instance).entryCount).toBe(2);
    expect(get(instance, 'doc1')).toBeDefined();
    expect(get(instance, 'doc2')!.context).toEqual({ tag: 'test' });
  });

  it('calls embedMany on the embedder', async () => {
    const mockEmbedder = createMockEmbedder(3);
    const spy = vi.spyOn(mockEmbedder, 'embedMany');
    const instance = create({ dimensions: 3, embedder: mockEmbedder });

    await addManyWithText(instance, [
      { id: 'a', text: 'one' },
      { id: 'b', text: 'two' },
    ]);

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(['one', 'two']);
  });
});

describe('queryByText', () => {
  it('embeds query text and returns results', async () => {
    const mockEmbedder = createMockEmbedder(3);
    const instance = create({ dimensions: 3, embedder: mockEmbedder });

    await addWithText(instance, { id: 'doc1', text: 'hello world' });
    await addWithText(instance, { id: 'doc2', text: 'foo bar baz' });

    const results = await queryByText(instance, { text: 'hello world', topK: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('doc1');
  });

  it('supports filter parameter', async () => {
    const mockEmbedder = createMockEmbedder(3);
    const instance = create({ dimensions: 3, embedder: mockEmbedder });

    await addWithText(instance, { id: 'a', text: 'hello', context: { group: 'X' } });
    await addWithText(instance, { id: 'b', text: 'hello', context: { group: 'Y' } });

    const results = await queryByText(instance, {
      text: 'hello',
      filter: (ctx) => ctx?.group === 'X',
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('a');
  });

  it('throws if no embedder is configured', async () => {
    const instance = create({ dimensions: 3 });
    await expect(queryByText(instance, { text: 'hello' })).rejects.toThrow(VCoreError);
  });
});
