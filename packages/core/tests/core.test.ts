import { describe, it, expect } from 'vitest';
import { create, stats, flush } from '../src/core.js';
import { add } from '../src/collection.js';
import { createMemoryDriver } from '../src/storage/memory.js';
import { InvalidConfigError } from '../src/errors.js';

describe('create', () => {
  it('creates instance with minimal config', () => {
    const instance = create({ dimensions: 128 });
    expect(instance.config.dimensions).toBe(128);
    expect(instance.config.quantization).toBe('F32');
    expect(instance.config.metric).toBe('cosine');
    expect(instance.entries.size).toBe(0);
  });

  it('creates instance with full config', () => {
    const driver = createMemoryDriver();
    const instance = create({
      dimensions: 64,
      quantization: 'INT8',
      metric: 'euclidean',
      storageDriver: driver,
    });
    expect(instance.config.dimensions).toBe(64);
    expect(instance.config.quantization).toBe('INT8');
    expect(instance.config.metric).toBe('euclidean');
  });

  it('throws on invalid config', () => {
    expect(() => create({ dimensions: 0 })).toThrow(InvalidConfigError);
  });
});

describe('stats', () => {
  it('returns correct values for empty instance', () => {
    const instance = create({ dimensions: 128, quantization: 'INT8', metric: 'euclidean' });
    const s = stats(instance);
    expect(s.entryCount).toBe(0);
    expect(s.dimensions).toBe(128);
    expect(s.quantization).toBe('INT8');
    expect(s.metric).toBe('euclidean');
    expect(s.indexStatus).toBe('brute-force');
  });

  it('reflects entry count after adds', () => {
    const instance = create({ dimensions: 2 });
    add(instance, { id: 'a', embedding: [1, 2] });
    add(instance, { id: 'b', embedding: [3, 4] });
    expect(stats(instance).entryCount).toBe(2);
  });
});

describe('flush', () => {
  it('persists data to storage driver', async () => {
    const driver = createMemoryDriver();
    const instance = create({ dimensions: 2, storageDriver: driver });
    add(instance, { id: 'a', embedding: [1, 2] });

    await flush(instance);

    expect(instance.dirty).toBe(false);
    expect(await driver.exists(instance.collectionId)).toBe(true);
  });
});
