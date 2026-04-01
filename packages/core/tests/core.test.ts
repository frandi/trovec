import { describe, it, expect } from 'vitest';
import { create, stats, flush } from '../src/core.js';
import { add } from '../src/collection.js';
import { createMemoryDriver } from '../src/storage/memory.js';
import { InvalidConfigError } from '../src/errors.js';

describe('create', () => {
  it('creates instance with minimal config', async () => {
    const instance = await create({ dimensions: 128 });
    expect(instance.config.dimensions).toBe(128);
    expect(instance.config.quantization).toBe('F32');
    expect(instance.config.metric).toBe('cosine');
    expect(instance.entries.size).toBe(0);
  });

  it('creates instance with full config', async () => {
    const driver = createMemoryDriver();
    const instance = await create({
      dimensions: 64,
      quantization: 'INT8',
      metric: 'euclidean',
      storageDriver: driver,
    });
    expect(instance.config.dimensions).toBe(64);
    expect(instance.config.quantization).toBe('INT8');
    expect(instance.config.metric).toBe('euclidean');
  });

  it('throws on invalid config', async () => {
    await expect(create({ dimensions: 0 })).rejects.toThrow(InvalidConfigError);
  });

  it('auto-loads existing data from storage driver', async () => {
    const driver = createMemoryDriver();
    const instance1 = await create({ dimensions: 2, storageDriver: driver, collectionId: 'test' });
    add(instance1, { id: 'a', embedding: [1, 2] });
    await flush(instance1);

    const instance2 = await create({ dimensions: 2, storageDriver: driver, collectionId: 'test' });
    expect(instance2.entries.size).toBe(1);
    expect(instance2.get('a')).toBeDefined();
  });
});

describe('stats', () => {
  it('returns correct values for empty instance', async () => {
    const instance = await create({ dimensions: 128, quantization: 'INT8', metric: 'euclidean' });
    const s = stats(instance);
    expect(s.entryCount).toBe(0);
    expect(s.dimensions).toBe(128);
    expect(s.quantization).toBe('INT8');
    expect(s.metric).toBe('euclidean');
    expect(s.indexStatus).toBe('brute-force');
  });

  it('reflects entry count after adds', async () => {
    const instance = await create({ dimensions: 2 });
    add(instance, { id: 'a', embedding: [1, 2] });
    add(instance, { id: 'b', embedding: [3, 4] });
    expect(stats(instance).entryCount).toBe(2);
  });
});

describe('flush', () => {
  it('persists data to storage driver', async () => {
    const driver = createMemoryDriver();
    const instance = await create({ dimensions: 2, storageDriver: driver });
    add(instance, { id: 'a', embedding: [1, 2] });

    await flush(instance);

    expect(instance.dirty).toBe(false);
    expect(await driver.exists(instance.collectionId)).toBe(true);
  });
});
