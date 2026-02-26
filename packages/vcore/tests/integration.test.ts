import { describe, it, expect } from 'vitest';
import { create, stats, flush } from '../src/core.js';
import { add, addMany, del, get } from '../src/collection.js';
import { query } from '../src/query.js';
import { deserialize } from '../src/serialization.js';
import { createMemoryDriver } from '../src/storage/memory.js';
import { randomVector } from './helpers.js';

describe('integration', () => {
  it('full pipeline: create -> add -> query -> verify', () => {
    const instance = create({ dimensions: 3, metric: 'cosine' });

    add(instance, { id: 'cat', embedding: [1, 0, 0], context: { type: 'animal' } });
    add(instance, { id: 'dog', embedding: [0.9, 0.1, 0], context: { type: 'animal' } });
    add(instance, { id: 'car', embedding: [0, 0, 1], context: { type: 'vehicle' } });

    const results = query(instance, { vector: [1, 0, 0], topK: 2 });
    expect(results.length).toBe(2);
    expect(results[0].id).toBe('cat');
    expect(results[1].id).toBe('dog');

    expect(stats(instance).entryCount).toBe(3);
  });

  it('filtered query only returns matching entries', () => {
    const instance = create({ dimensions: 2 });
    add(instance, { id: '1', embedding: [1, 0], context: { group: 'A' } });
    add(instance, { id: '2', embedding: [0.9, 0.1], context: { group: 'B' } });
    add(instance, { id: '3', embedding: [0.8, 0.2], context: { group: 'A' } });

    const results = query(instance, {
      vector: [1, 0],
      filter: (ctx) => ctx?.group === 'A',
    });

    expect(results.every((r) => r.context?.group === 'A')).toBe(true);
    expect(results.length).toBe(2);
  });

  it('interleaved add/delete/query', () => {
    const instance = create({ dimensions: 2 });
    add(instance, { id: 'a', embedding: [1, 0] });
    add(instance, { id: 'b', embedding: [0, 1] });

    expect(query(instance, { vector: [1, 0] }).length).toBe(2);

    del(instance, 'b');
    expect(query(instance, { vector: [1, 0] }).length).toBe(1);
    expect(get(instance, 'b')).toBeUndefined();

    add(instance, { id: 'c', embedding: [0.5, 0.5] });
    expect(query(instance, { vector: [1, 0] }).length).toBe(2);
  });

  it('flush + deserialize recovers state', async () => {
    const driver = createMemoryDriver();
    const instance = create({ dimensions: 3, storageDriver: driver });
    addMany(instance, [
      { id: 'x', embedding: [1, 2, 3], context: { tag: 'hello' } },
      { id: 'y', embedding: [4, 5, 6] },
    ]);

    await flush(instance);

    // Create new instance and load from storage
    const instance2 = create({ dimensions: 3, storageDriver: driver });
    const buffer = await driver.read(instance.collectionId);
    expect(buffer).not.toBeNull();
    deserialize(buffer!, instance2);

    expect(instance2.entries.size).toBe(2);
    expect(get(instance2, 'x')!.embedding).toEqual([1, 2, 3]);
    expect(get(instance2, 'x')!.context).toEqual({ tag: 'hello' });
    expect(get(instance2, 'y')!.embedding).toEqual([4, 5, 6]);
  });

  it('mixed string and bigint ids', () => {
    const instance = create({ dimensions: 2 });
    add(instance, { id: 'abc', embedding: [1, 0] });
    add(instance, { id: 123n, embedding: [0, 1] });

    expect(instance.entries.size).toBe(2);
    expect(get(instance, 'abc')!.embedding).toEqual([1, 0]);
    expect(get(instance, 123n)!.embedding).toEqual([0, 1]);
  });

  it('handles all metric types', () => {
    for (const metric of ['cosine', 'euclidean', 'dot'] as const) {
      const instance = create({ dimensions: 3, metric });
      add(instance, { id: 'a', embedding: [1, 0, 0] });
      add(instance, { id: 'b', embedding: [0, 1, 0] });
      const results = query(instance, { vector: [1, 0, 0], topK: 2 });
      expect(results.length).toBe(2);
      expect(results[0].id).toBe('a');
    }

    // Hamming requires BIT
    const instance = create({ dimensions: 8, quantization: 'BIT', metric: 'hamming' });
    add(instance, { id: 'a', embedding: [1, 1, 1, 1, 1, 1, 1, 1] });
    add(instance, { id: 'b', embedding: [-1, -1, -1, -1, -1, -1, -1, -1] });
    const results = query(instance, { vector: [1, 1, 1, 1, 1, 1, 1, 1], topK: 2 });
    expect(results[0].id).toBe('a');
  });

  it('large-ish dataset (1000 entries, 128 dimensions)', () => {
    const instance = create({ dimensions: 128 });

    const entries = Array.from({ length: 1000 }, (_, i) => ({
      id: `entry_${i}`,
      embedding: randomVector(128),
    }));

    addMany(instance, entries);
    expect(stats(instance).entryCount).toBe(1000);

    const results = query(instance, { vector: randomVector(128), topK: 5 });
    expect(results.length).toBe(5);
    // Scores should be descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });
});
