import { describe, it, expect, vi } from 'vitest';
import { create, stats, flush } from '../src/core.js';
import { add } from '../src/collection.js';
import { createMemoryDriver } from '../src/storage/memory.js';
import { InvalidConfigError } from '../src/errors.js';
import { createMockEmbedder } from './helpers.js';

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
      autoFlush: false,
    });
    expect(instance.config.dimensions).toBe(64);
    expect(instance.config.quantization).toBe('INT8');
    expect(instance.config.metric).toBe('euclidean');
  });

  it('throws on invalid config', async () => {
    await expect(create({ dimensions: 0 })).rejects.toThrow(InvalidConfigError);
  });

  it('throws when no dimensions and no embedder', async () => {
    await expect(create({})).rejects.toThrow('dimensions is required when no embedder is provided');
  });

  it('resolves dimensions from embedder', async () => {
    const embedder = {
      dimensions: 5,
      async embed() { return { embedding: [1, 2, 3, 4, 5] }; },
      async embedMany() { return []; },
    };
    const instance = await create({ embedder });
    expect(instance.config.dimensions).toBe(5);
  });

  it('accepts matching explicit dimensions with embedder', async () => {
    const embedder = {
      dimensions: 5,
      async embed() { return { embedding: [1, 2, 3, 4, 5] }; },
      async embedMany() { return []; },
    };
    const instance = await create({ dimensions: 5, embedder });
    expect(instance.config.dimensions).toBe(5);
  });

  it('throws on dimensions mismatch with embedder', async () => {
    const embedder = {
      dimensions: 5,
      async embed() { return { embedding: [1, 2, 3, 4, 5] }; },
      async embedMany() { return []; },
    };
    await expect(create({ dimensions: 10, embedder })).rejects.toThrow('dimensions mismatch');
  });

  it('auto-loads existing data from storage driver', async () => {
    const driver = createMemoryDriver();
    const instance1 = await create({ dimensions: 2, storageDriver: driver, collectionId: 'test', autoFlush: false });
    add(instance1, { id: 'a', embedding: [1, 2] });
    await flush(instance1);

    const instance2 = await create({ dimensions: 2, storageDriver: driver, collectionId: 'test', autoFlush: false });
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
    const instance = await create({ dimensions: 2, storageDriver: driver, autoFlush: false });
    add(instance, { id: 'a', embedding: [1, 2] });

    await flush(instance);

    expect(instance.dirty).toBe(false);
    expect(await driver.exists(instance.collectionId)).toBe(true);
  });
});

describe('embedder identity on load', () => {
  it('warns when the loaded embedder differs from the persisted one', async () => {
    const driver = createMemoryDriver();
    const embedderA = createMockEmbedder(3, 'embedder-a@1.0.0');
    const embedderB = createMockEmbedder(3, 'embedder-b@1.0.0');

    const writer = await create({
      embedder: embedderA,
      storageDriver: driver,
      collectionId: 'test',
      autoFlush: false,
    });
    add(writer, { id: 'x', embedding: [0.1, 0.2, 0.3] });
    await flush(writer);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await create({
        embedder: embedderB,
        storageDriver: driver,
        collectionId: 'test',
        autoFlush: false,
      });
      expect(warnSpy).toHaveBeenCalledOnce();
      const message = warnSpy.mock.calls[0][0] as string;
      expect(message).toMatch(/Stored vectors may be incompatible/);
      expect(message).toMatch(/embedder-a@1\.0\.0/);
      expect(message).toMatch(/embedder-b@1\.0\.0/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn when the loaded embedder matches the persisted one', async () => {
    const driver = createMemoryDriver();
    const embedder = createMockEmbedder(3, 'same@1.0.0');

    const writer = await create({
      embedder,
      storageDriver: driver,
      collectionId: 'test',
      autoFlush: false,
    });
    add(writer, { id: 'x', embedding: [0.1, 0.2, 0.3] });
    await flush(writer);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await create({
        embedder: createMockEmbedder(3, 'same@1.0.0'),
        storageDriver: driver,
        collectionId: 'test',
        autoFlush: false,
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn when no embedder is configured on load', async () => {
    const driver = createMemoryDriver();
    const writer = await create({
      embedder: createMockEmbedder(3, 'embedder-a@1.0.0'),
      storageDriver: driver,
      collectionId: 'test',
      autoFlush: false,
    });
    add(writer, { id: 'x', embedding: [0.1, 0.2, 0.3] });
    await flush(writer);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await create({
        dimensions: 3,
        storageDriver: driver,
        collectionId: 'test',
        autoFlush: false,
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn when the persisted file has no embedder identity', async () => {
    const driver = createMemoryDriver();
    const writer = await create({
      dimensions: 3,
      storageDriver: driver,
      collectionId: 'test',
      autoFlush: false,
    });
    add(writer, { id: 'x', embedding: [0.1, 0.2, 0.3] });
    await flush(writer);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await create({
        embedder: createMockEmbedder(3, 'embedder-b@1.0.0'),
        storageDriver: driver,
        collectionId: 'test',
        autoFlush: false,
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn when loading a hand-crafted v1 file', async () => {
    // Hand-build a v1 buffer with no metadata section, write it directly to a
    // memory driver, then create() should auto-load it without warning even
    // when an embedder is configured on the new instance.
    const HEADER_SIZE = 16;
    const MAGIC = Buffer.from('VCR\x01');
    const idStr = 'a';
    const idBuf = Buffer.from(idStr, 'utf-8');
    const v1 = Buffer.alloc(HEADER_SIZE + 1 + 4 + idBuf.length + 3 * 8 + 4);
    let off = 0;
    MAGIC.copy(v1, off); off += 4;
    v1.writeUInt8(1, off); off += 1; // version 1
    v1.writeUInt32LE(3, off); off += 4; // dimensions
    v1.writeUInt8(0, off); off += 1; // F32
    v1.writeUInt8(0, off); off += 1; // cosine
    v1.writeUInt32LE(1, off); off += 4; // 1 entry
    v1.writeUInt8(0, off); off += 1; // reserved
    v1.writeUInt8(0, off); off += 1; // id type: string
    v1.writeUInt32LE(idBuf.length, off); off += 4;
    idBuf.copy(v1, off); off += idBuf.length;
    v1.writeDoubleLE(1, off); off += 8;
    v1.writeDoubleLE(2, off); off += 8;
    v1.writeDoubleLE(3, off); off += 8;
    v1.writeUInt32LE(0, off); // empty context

    const driver = createMemoryDriver();
    await driver.write('test', v1);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const instance = await create({
        embedder: createMockEmbedder(3, 'embedder-b@1.0.0'),
        storageDriver: driver,
        collectionId: 'test',
        autoFlush: false,
      });
      expect(warnSpy).not.toHaveBeenCalled();
      expect(instance.entries.size).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
