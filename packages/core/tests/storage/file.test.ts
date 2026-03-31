import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileDriver } from '../../src/storage/file.js';
import { create, flush, stats } from '../../src/core.js';
import { add, addMany, get } from '../../src/collection.js';
import { query } from '../../src/query.js';
import { deserialize } from '../../src/serialization.js';

describe('FileStorageDriver', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'trovec-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('write then read returns same buffer', async () => {
    const driver = createFileDriver({ directory: dir, compression: false });
    const data = Buffer.from('hello world');
    await driver.write('col1', data);
    const result = await driver.read('col1');
    expect(result).toEqual(data);
  });

  it('write then read with compression returns same buffer', async () => {
    const driver = createFileDriver({ directory: dir });
    const data = Buffer.from('hello world'.repeat(100));
    await driver.write('col1', data);
    const result = await driver.read('col1');
    expect(result).toEqual(data);
  });

  it('compressed file is smaller than original data', async () => {
    const driver = createFileDriver({ directory: dir });
    const data = Buffer.from('hello world'.repeat(1000));
    await driver.write('col1', data);
    const fileOnDisk = await readFile(join(dir, 'col1.trovec'));
    expect(fileOnDisk.length).toBeLessThan(data.length);
  });

  it('read non-existent returns null', async () => {
    const driver = createFileDriver({ directory: dir });
    expect(await driver.read('missing')).toBeNull();
  });

  it('exists returns correct boolean', async () => {
    const driver = createFileDriver({ directory: dir });
    expect(await driver.exists('col1')).toBe(false);
    await driver.write('col1', Buffer.from('data'));
    expect(await driver.exists('col1')).toBe(true);
  });

  it('delete returns true if existed', async () => {
    const driver = createFileDriver({ directory: dir });
    await driver.write('col1', Buffer.from('data'));
    expect(await driver.delete('col1')).toBe(true);
    expect(await driver.exists('col1')).toBe(false);
  });

  it('delete returns false if not existed', async () => {
    const driver = createFileDriver({ directory: dir });
    expect(await driver.delete('missing')).toBe(false);
  });

  it('overwrites existing key', async () => {
    const driver = createFileDriver({ directory: dir, compression: false });
    await driver.write('col1', Buffer.from('first'));
    await driver.write('col1', Buffer.from('second'));
    const result = await driver.read('col1');
    expect(result?.toString()).toBe('second');
  });

  it('creates directory if it does not exist', async () => {
    const nested = join(dir, 'sub', 'deep');
    const driver = createFileDriver({ directory: nested });
    await driver.write('col1', Buffer.from('data'));
    const result = await driver.read('col1');
    expect(result?.toString()).toBe('data');
  });

  it('supports custom compression levels', async () => {
    const data = Buffer.from('compressible data '.repeat(500));

    const driverFast = createFileDriver({ directory: dir, compressionLevel: 1 });
    await driverFast.write('fast', data);
    const resultFast = await driverFast.read('fast');
    expect(resultFast).toEqual(data);

    const driverMax = createFileDriver({ directory: dir, compressionLevel: 11 });
    await driverMax.write('max', data);
    const resultMax = await driverMax.read('max');
    expect(resultMax).toEqual(data);

    // Higher compression level should produce smaller or equal output
    const fastFile = await readFile(join(dir, 'fast.trovec'));
    const maxFile = await readFile(join(dir, 'max.trovec'));
    expect(maxFile.length).toBeLessThanOrEqual(fastFile.length);
  });

  it('no temp file left after successful write', async () => {
    const driver = createFileDriver({ directory: dir });
    await driver.write('col1', Buffer.from('data'));
    await expect(readFile(join(dir, 'col1.trovec.tmp'))).rejects.toThrow();
  });

  it('exposes resolved directory path', () => {
    const driver = createFileDriver({ directory: dir });
    expect(driver.directory).toBe(dir);
  });

  it('uses default directory when no options provided', () => {
    const driver = createFileDriver();
    expect(driver.directory).toContain('.trovec');
  });

  it('destroy removes the entire data directory', async () => {
    const nested = join(dir, 'destroyable');
    const driver = createFileDriver({ directory: nested });
    await driver.write('col1', Buffer.from('data'));
    expect(await driver.exists('col1')).toBe(true);

    await driver.destroy();

    // Directory and files should be gone
    expect(await driver.exists('col1')).toBe(false);
    // Can write again after destroy (re-creates directory)
    await driver.write('col2', Buffer.from('new'));
    expect(await driver.read('col2')).toEqual(Buffer.from('new'));
  });

  describe('integration with trovec', () => {
    it('flush + deserialize recovers state with file driver', async () => {
      const driver = createFileDriver({ directory: dir });
      const instance = create({ dimensions: 3, storageDriver: driver });

      addMany(instance, [
        { id: 'x', embedding: [1, 2, 3], context: { tag: 'hello' } },
        { id: 'y', embedding: [4, 5, 6] },
      ]);

      await flush(instance);

      const instance2 = create({ dimensions: 3, storageDriver: driver });
      const buffer = await driver.read(instance.collectionId);
      expect(buffer).not.toBeNull();
      deserialize(buffer!, instance2);

      expect(instance2.entries.size).toBe(2);
      expect(get(instance2, 'x')!.embedding).toEqual([1, 2, 3]);
      expect(get(instance2, 'x')!.context).toEqual({ tag: 'hello' });
      expect(get(instance2, 'y')!.embedding).toEqual([4, 5, 6]);
    });

    it('query results match after persist + restore', async () => {
      const driver = createFileDriver({ directory: dir });
      const instance = create({ dimensions: 3, metric: 'cosine', storageDriver: driver });

      add(instance, { id: 'cat', embedding: [1, 0, 0], context: { type: 'animal' } });
      add(instance, { id: 'dog', embedding: [0.9, 0.1, 0], context: { type: 'animal' } });
      add(instance, { id: 'car', embedding: [0, 0, 1], context: { type: 'vehicle' } });

      const originalResults = query(instance, { vector: [1, 0, 0], topK: 2 });
      await flush(instance);

      const instance2 = create({ dimensions: 3, metric: 'cosine', storageDriver: driver });
      const buffer = await driver.read(instance.collectionId);
      deserialize(buffer!, instance2);

      const restoredResults = query(instance2, { vector: [1, 0, 0], topK: 2 });
      expect(restoredResults).toEqual(originalResults);
    });

    it('works with INT8 quantization', async () => {
      const driver = createFileDriver({ directory: dir });
      const instance = create({ dimensions: 3, quantization: 'INT8', storageDriver: driver });

      add(instance, { id: 'a', embedding: [0.5, 0.3, 0.1] });
      await flush(instance);

      const instance2 = create({ dimensions: 3, quantization: 'INT8', storageDriver: driver });
      const buffer = await driver.read(instance.collectionId);
      deserialize(buffer!, instance2);

      expect(stats(instance2).entryCount).toBe(1);
    });

    it('works with BIT quantization', async () => {
      const driver = createFileDriver({ directory: dir });
      const instance = create({ dimensions: 8, quantization: 'BIT', metric: 'hamming', storageDriver: driver });

      add(instance, { id: 'a', embedding: [1, 1, 1, 1, -1, -1, -1, -1] });
      await flush(instance);

      const instance2 = create({ dimensions: 8, quantization: 'BIT', metric: 'hamming', storageDriver: driver });
      const buffer = await driver.read(instance.collectionId);
      deserialize(buffer!, instance2);

      expect(stats(instance2).entryCount).toBe(1);
    });
  });
});
