import { describe, it, expect } from 'vitest';
import { create } from '../src/core.js';
import { add, addMany, get } from '../src/collection.js';
import { serialize, deserialize } from '../src/serialization.js';

describe('serialization', () => {
  it('round-trips F32 entries', () => {
    const instance = create({ dimensions: 3 });
    addMany(instance, [
      { id: 'a', embedding: [1, 2, 3], context: { label: 'first' } },
      { id: 'b', embedding: [4, 5, 6] },
    ]);

    const buffer = serialize(instance);

    const instance2 = create({ dimensions: 3 });
    deserialize(buffer, instance2);

    expect(instance2.entries.size).toBe(2);
    const a = get(instance2, 'a');
    expect(a!.embedding).toEqual([1, 2, 3]);
    expect(a!.context).toEqual({ label: 'first' });
    const b = get(instance2, 'b');
    expect(b!.embedding).toEqual([4, 5, 6]);
    expect(b!.context).toBeUndefined();
  });

  it('round-trips INT8 entries', () => {
    const instance = create({ dimensions: 3, quantization: 'INT8' });
    add(instance, { id: 'a', embedding: [0.1, 0.5, 0.9] });

    const buffer = serialize(instance);

    const instance2 = create({ dimensions: 3, quantization: 'INT8' });
    deserialize(buffer, instance2);

    const a = get(instance2, 'a');
    expect(a).toBeDefined();
    expect(a!.embedding[0]).toBeCloseTo(0.1, 1);
    expect(a!.embedding[1]).toBeCloseTo(0.5, 1);
    expect(a!.embedding[2]).toBeCloseTo(0.9, 1);
  });

  it('round-trips BIT entries', () => {
    const instance = create({ dimensions: 8, quantization: 'BIT', metric: 'hamming' });
    add(instance, { id: 'a', embedding: [1, -1, 1, -1, 1, -1, 1, -1] });

    const buffer = serialize(instance);

    const instance2 = create({ dimensions: 8, quantization: 'BIT', metric: 'hamming' });
    deserialize(buffer, instance2);

    const a = get(instance2, 'a');
    expect(a!.embedding).toEqual([1, -1, 1, -1, 1, -1, 1, -1]);
  });

  it('round-trips bigint ids', () => {
    const instance = create({ dimensions: 2 });
    add(instance, { id: 42n, embedding: [1, 2] });

    const buffer = serialize(instance);

    const instance2 = create({ dimensions: 2 });
    deserialize(buffer, instance2);

    const entry = get(instance2, 42n);
    expect(entry).toBeDefined();
    expect(entry!.id).toBe(42n);
  });

  it('round-trips entries with no context', () => {
    const instance = create({ dimensions: 2 });
    add(instance, { id: 'a', embedding: [1, 2] });

    const buffer = serialize(instance);

    const instance2 = create({ dimensions: 2 });
    deserialize(buffer, instance2);

    const a = get(instance2, 'a');
    expect(a!.context).toBeUndefined();
  });

  it('throws on dimension mismatch', () => {
    const instance1 = create({ dimensions: 3 });
    add(instance1, { id: 'a', embedding: [1, 2, 3] });
    const buffer = serialize(instance1);

    const instance2 = create({ dimensions: 5 });
    expect(() => deserialize(buffer, instance2)).toThrow(/Dimension mismatch/);
  });

  it('throws on invalid magic bytes', () => {
    const instance = create({ dimensions: 2 });
    const buffer = Buffer.alloc(16);
    expect(() => deserialize(buffer, instance)).toThrow(/Invalid magic/);
  });
});
