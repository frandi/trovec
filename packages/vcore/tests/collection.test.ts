import { describe, it, expect } from 'vitest';
import { create } from '../src/core.js';
import { add, addMany, del, get } from '../src/collection.js';
import { DimensionMismatchError } from '../src/errors.js';

describe('add', () => {
  it('adds and retrieves a single entry', () => {
    const instance = create({ dimensions: 3 });
    add(instance, { id: 'a', embedding: [1, 2, 3] });
    const entry = get(instance, 'a');
    expect(entry).toBeDefined();
    expect(entry!.id).toBe('a');
    expect(entry!.embedding).toEqual([1, 2, 3]);
  });

  it('throws on dimension mismatch', () => {
    const instance = create({ dimensions: 3 });
    expect(() => add(instance, { id: 'a', embedding: [1, 2] })).toThrow(DimensionMismatchError);
  });

  it('replaces existing entry with same id', () => {
    const instance = create({ dimensions: 2 });
    add(instance, { id: 'a', embedding: [1, 2] });
    add(instance, { id: 'a', embedding: [3, 4] });
    const entry = get(instance, 'a');
    expect(entry!.embedding).toEqual([3, 4]);
    expect(instance.entries.size).toBe(1);
  });

  it('preserves context', () => {
    const instance = create({ dimensions: 2 });
    add(instance, { id: 'a', embedding: [1, 2], context: { label: 'test' } });
    const entry = get(instance, 'a');
    expect(entry!.context).toEqual({ label: 'test' });
  });

  it('sets dirty flag', () => {
    const instance = create({ dimensions: 2 });
    expect(instance.dirty).toBe(false);
    add(instance, { id: 'a', embedding: [1, 2] });
    expect(instance.dirty).toBe(true);
  });
});

describe('addMany', () => {
  it('batch inserts multiple entries', () => {
    const instance = create({ dimensions: 2 });
    addMany(instance, [
      { id: 'a', embedding: [1, 2] },
      { id: 'b', embedding: [3, 4] },
    ]);
    expect(instance.entries.size).toBe(2);
    expect(get(instance, 'a')).toBeDefined();
    expect(get(instance, 'b')).toBeDefined();
  });

  it('is atomic — no entries inserted if one fails validation', () => {
    const instance = create({ dimensions: 2 });
    expect(() =>
      addMany(instance, [
        { id: 'a', embedding: [1, 2] },
        { id: 'b', embedding: [3] }, // wrong dimension
      ]),
    ).toThrow();
    expect(instance.entries.size).toBe(0);
  });

  it('handles empty array without error', () => {
    const instance = create({ dimensions: 2 });
    addMany(instance, []);
    expect(instance.entries.size).toBe(0);
  });
});

describe('del', () => {
  it('returns true when entry existed', () => {
    const instance = create({ dimensions: 2 });
    add(instance, { id: 'a', embedding: [1, 2] });
    expect(del(instance, 'a')).toBe(true);
    expect(instance.entries.size).toBe(0);
  });

  it('returns false when entry did not exist', () => {
    const instance = create({ dimensions: 2 });
    expect(del(instance, 'missing')).toBe(false);
  });
});

describe('get', () => {
  it('returns undefined for non-existent id', () => {
    const instance = create({ dimensions: 2 });
    expect(get(instance, 'missing')).toBeUndefined();
  });

  it('returns dequantized embedding for INT8', () => {
    const instance = create({ dimensions: 3, quantization: 'INT8' });
    add(instance, { id: 'a', embedding: [0.1, 0.5, 0.9] });
    const entry = get(instance, 'a');
    expect(entry).toBeDefined();
    // Values should be close but may have quantization error
    expect(entry!.embedding[0]).toBeCloseTo(0.1, 1);
    expect(entry!.embedding[1]).toBeCloseTo(0.5, 1);
    expect(entry!.embedding[2]).toBeCloseTo(0.9, 1);
  });

  it('works with bigint ids', () => {
    const instance = create({ dimensions: 2 });
    add(instance, { id: 42n, embedding: [1, 2] });
    expect(get(instance, 42n)).toBeDefined();
    expect(get(instance, 'missing')).toBeUndefined();
  });

  it('string and bigint ids do not collide', () => {
    const instance = create({ dimensions: 2 });
    add(instance, { id: '123', embedding: [1, 2] });
    add(instance, { id: 123n, embedding: [3, 4] });
    expect(instance.entries.size).toBe(2);
    expect(get(instance, '123')!.embedding).toEqual([1, 2]);
    expect(get(instance, 123n)!.embedding).toEqual([3, 4]);
  });
});
