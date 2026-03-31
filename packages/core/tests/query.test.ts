import { describe, it, expect } from 'vitest';
import { create } from '../src/core.js';
import { add, addMany } from '../src/collection.js';
import { query } from '../src/query.js';

describe('query', () => {
  it('returns topK results sorted by score descending', async () => {
    const instance = await create({ dimensions: 2 });
    add(instance, { id: 'a', embedding: [1, 0] });
    add(instance, { id: 'b', embedding: [0, 1] });
    add(instance, { id: 'c', embedding: [0.9, 0.1] });

    const results = query(instance, { vector: [1, 0], topK: 2 });

    expect(results.length).toBe(2);
    expect(results[0].id).toBe('a'); // most similar to [1,0]
    expect(results[0].score).toBeCloseTo(1.0);
  });

  it('defaults topK to 10', async () => {
    const instance = await create({ dimensions: 2 });
    for (let i = 0; i < 15; i++) {
      add(instance, { id: `e${i}`, embedding: [Math.random(), Math.random()] });
    }

    const results = query(instance, { vector: [1, 0] });
    expect(results.length).toBe(10);
  });

  it('applies filter before scoring', async () => {
    const instance = await create({ dimensions: 2 });
    add(instance, { id: 'a', embedding: [1, 0], context: { category: 'X' } });
    add(instance, { id: 'b', embedding: [1, 0], context: { category: 'Y' } });

    const results = query(instance, {
      vector: [1, 0],
      filter: (ctx) => ctx?.category === 'X',
    });

    expect(results.length).toBe(1);
    expect(results[0].id).toBe('a');
  });

  it('tie-breaks by lower ID first (string lexicographic)', async () => {
    const instance = await create({ dimensions: 2, metric: 'dot' });
    // Same embedding = same score
    add(instance, { id: 'b', embedding: [1, 0] });
    add(instance, { id: 'a', embedding: [1, 0] });

    const results = query(instance, { vector: [1, 0], topK: 2 });
    expect(results[0].id).toBe('a');
    expect(results[1].id).toBe('b');
  });

  it('tie-breaks by lower ID first (bigint numeric)', async () => {
    const instance = await create({ dimensions: 2, metric: 'dot' });
    add(instance, { id: 200n, embedding: [1, 0] });
    add(instance, { id: 100n, embedding: [1, 0] });

    const results = query(instance, { vector: [1, 0], topK: 2 });
    expect(results[0].id).toBe(100n);
    expect(results[1].id).toBe(200n);
  });

  it('returns empty array for empty collection', async () => {
    const instance = await create({ dimensions: 2 });
    const results = query(instance, { vector: [1, 0] });
    expect(results).toEqual([]);
  });

  it('throws on vector dimension mismatch', async () => {
    const instance = await create({ dimensions: 3 });
    expect(() => query(instance, { vector: [1, 0] })).toThrow();
  });

  it('includes context in results', async () => {
    const instance = await create({ dimensions: 2 });
    add(instance, { id: 'a', embedding: [1, 0], context: { label: 'test' } });

    const results = query(instance, { vector: [1, 0] });
    expect(results[0].context).toEqual({ label: 'test' });
  });

  it('works with INT8 quantization', async () => {
    const instance = await create({ dimensions: 3, quantization: 'INT8' });
    addMany(instance, [
      { id: 'a', embedding: [1, 0, 0] },
      { id: 'b', embedding: [0, 1, 0] },
      { id: 'c', embedding: [0, 0, 1] },
    ]);

    const results = query(instance, { vector: [1, 0, 0], topK: 1 });
    expect(results[0].id).toBe('a');
  });

  it('works with BIT quantization and hamming metric', async () => {
    const instance = await create({ dimensions: 8, quantization: 'BIT', metric: 'hamming' });
    add(instance, { id: 'a', embedding: [1, 1, 1, 1, -1, -1, -1, -1] });
    add(instance, { id: 'b', embedding: [-1, -1, -1, -1, 1, 1, 1, 1] });

    const results = query(instance, { vector: [1, 1, 1, 1, -1, -1, -1, -1], topK: 2 });
    expect(results[0].id).toBe('a');
    expect(results[0].score).toBeCloseTo(1.0);
    expect(results[1].id).toBe('b');
    expect(results[1].score).toBeCloseTo(0.0);
  });
});
