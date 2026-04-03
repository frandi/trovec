import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConcurrentFileDriver } from '../../src/storage/concurrent-file.js';
import { create, flush, close, stats } from '../../src/core.js';
import { add, addMany, get, del } from '../../src/collection.js';
import { query } from '../../src/query.js';

describe('ConcurrentFileDriver', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'trovec-concurrent-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('locking only (wal: false)', () => {
    it('write then read returns same buffer', async () => {
      const driver = createConcurrentFileDriver({ directory: dir, compression: false });
      const data = Buffer.from('hello world');
      await driver.write('col1', data);
      const result = await driver.read('col1');
      expect(result).toEqual(data);
    });

    it('write then read with compression returns same buffer', async () => {
      const driver = createConcurrentFileDriver({ directory: dir });
      const data = Buffer.from('hello world'.repeat(100));
      await driver.write('col1', data);
      const result = await driver.read('col1');
      expect(result).toEqual(data);
    });

    it('read non-existent returns null', async () => {
      const driver = createConcurrentFileDriver({ directory: dir });
      expect(await driver.read('missing')).toBeNull();
    });

    it('exists returns correct boolean', async () => {
      const driver = createConcurrentFileDriver({ directory: dir });
      expect(await driver.exists('col1')).toBe(false);
      await driver.write('col1', Buffer.from('data'));
      expect(await driver.exists('col1')).toBe(true);
    });

    it('delete returns true if existed', async () => {
      const driver = createConcurrentFileDriver({ directory: dir });
      await driver.write('col1', Buffer.from('data'));
      expect(await driver.delete('col1')).toBe(true);
      expect(await driver.exists('col1')).toBe(false);
    });

    it('delete returns false if not existed', async () => {
      const driver = createConcurrentFileDriver({ directory: dir });
      expect(await driver.delete('missing')).toBe(false);
    });

    it('overwrites existing key', async () => {
      const driver = createConcurrentFileDriver({ directory: dir, compression: false });
      await driver.write('col1', Buffer.from('first'));
      await driver.write('col1', Buffer.from('second'));
      const result = await driver.read('col1');
      expect(result?.toString()).toBe('second');
    });

    it('creates directory if it does not exist', async () => {
      const nested = join(dir, 'sub', 'deep');
      const driver = createConcurrentFileDriver({ directory: nested });
      await driver.write('col1', Buffer.from('data'));
      const result = await driver.read('col1');
      expect(result?.toString()).toBe('data');
    });

    it('no lock file left after operations', async () => {
      const driver = createConcurrentFileDriver({ directory: dir });
      await driver.write('col1', Buffer.from('data'));
      await driver.read('col1');
      // Lock file should be cleaned up
      await expect(access(join(dir, 'col1.trovec.lock'))).rejects.toThrow();
    });

    it('destroy removes the entire data directory', async () => {
      const nested = join(dir, 'destroyable');
      const driver = createConcurrentFileDriver({ directory: nested });
      await driver.write('col1', Buffer.from('data'));
      expect(await driver.exists('col1')).toBe(true);
      await driver.destroy();
      expect(await driver.exists('col1')).toBe(false);
    });
  });

  describe('integration with trovec (locking only)', () => {
    it('flush + create auto-loads state', async () => {
      const driver = createConcurrentFileDriver({ directory: dir });
      const instance = await create({ dimensions: 3, storageDriver: driver, collectionId: 'test', autoFlush: false });

      addMany(instance, [
        { id: 'x', embedding: [1, 2, 3], context: { tag: 'hello' } },
        { id: 'y', embedding: [4, 5, 6] },
      ]);

      await flush(instance);

      const instance2 = await create({ dimensions: 3, storageDriver: driver, collectionId: 'test', autoFlush: false });
      expect(instance2.entries.size).toBe(2);
      expect(get(instance2, 'x')!.embedding).toEqual([1, 2, 3]);
      expect(get(instance2, 'x')!.context).toEqual({ tag: 'hello' });
    });

    it('query results match after persist + restore', async () => {
      const driver = createConcurrentFileDriver({ directory: dir });
      const instance = await create({ dimensions: 3, metric: 'cosine', storageDriver: driver, collectionId: 'test', autoFlush: false });

      add(instance, { id: 'cat', embedding: [1, 0, 0] });
      add(instance, { id: 'dog', embedding: [0.9, 0.1, 0] });
      add(instance, { id: 'car', embedding: [0, 0, 1] });

      const originalResults = query(instance, { vector: [1, 0, 0], topK: 2 });
      await flush(instance);

      const instance2 = await create({ dimensions: 3, metric: 'cosine', storageDriver: driver, collectionId: 'test', autoFlush: false });
      const restoredResults = query(instance2, { vector: [1, 0, 0], topK: 2 });
      expect(restoredResults).toEqual(originalResults);
    });
  });

  describe('WAL mode (wal: true)', () => {
    it('persists data via WAL and recovers on reload', async () => {
      const driver = createConcurrentFileDriver({ directory: dir, wal: true });
      const instance = await create({ dimensions: 3, storageDriver: driver, collectionId: 'waltest', autoFlush: false });

      // First flush on a fresh collection does a full write (no base file yet to derive config)
      add(instance, { id: 'a', embedding: [1, 0, 0], context: { type: 'first' } });
      await flush(instance);

      // Second flush should use WAL since base file now exists
      add(instance, { id: 'b', embedding: [0, 1, 0] });
      await flush(instance);

      // WAL file should exist after second flush
      await expect(access(join(dir, 'waltest.trovec.wal'))).resolves.toBeUndefined();

      // Reload — should merge base file + WAL
      const instance2 = await create({ dimensions: 3, storageDriver: driver, collectionId: 'waltest', autoFlush: false });
      expect(instance2.entries.size).toBe(2);
      expect(get(instance2, 'a')!.embedding).toEqual([1, 0, 0]);
      expect(get(instance2, 'a')!.context).toEqual({ type: 'first' });
      expect(get(instance2, 'b')!.embedding).toEqual([0, 1, 0]);
    });

    it('WAL handles add then delete', async () => {
      const driver = createConcurrentFileDriver({ directory: dir, wal: true });
      const instance = await create({ dimensions: 3, storageDriver: driver, collectionId: 'waltest', autoFlush: false });

      add(instance, { id: 'a', embedding: [1, 0, 0] });
      add(instance, { id: 'b', embedding: [0, 1, 0] });
      await flush(instance);

      del(instance, 'a');
      await flush(instance);

      const instance2 = await create({ dimensions: 3, storageDriver: driver, collectionId: 'waltest', autoFlush: false });
      expect(instance2.entries.size).toBe(1);
      expect(get(instance2, 'a')).toBeUndefined();
      expect(get(instance2, 'b')!.embedding).toEqual([0, 1, 0]);
    });

    it('checkpoint compacts WAL into base file', async () => {
      const driver = createConcurrentFileDriver({ directory: dir, wal: true });
      const instance = await create({ dimensions: 3, storageDriver: driver, collectionId: 'waltest', autoFlush: false });

      // First flush writes base file (fresh collection)
      add(instance, { id: 'a', embedding: [1, 0, 0] });
      await flush(instance);

      // Second flush uses WAL
      add(instance, { id: 'b', embedding: [0, 1, 0] });
      await flush(instance);

      // WAL should exist before checkpoint
      await expect(access(join(dir, 'waltest.trovec.wal'))).resolves.toBeUndefined();

      // Checkpoint: write full snapshot and delete WAL
      const { serialize } = await import('../../src/serialization.js');
      await driver.checkpoint('waltest', serialize(instance));

      // WAL should be deleted
      await expect(access(join(dir, 'waltest.trovec.wal'))).rejects.toThrow();

      // Base file should contain all data
      const instance2 = await create({ dimensions: 3, storageDriver: driver, collectionId: 'waltest', autoFlush: false });
      expect(instance2.entries.size).toBe(2);
    });

    it('WAL survives multiple flush cycles', async () => {
      const driver = createConcurrentFileDriver({ directory: dir, wal: true });
      const instance = await create({ dimensions: 3, storageDriver: driver, collectionId: 'waltest', autoFlush: false });

      add(instance, { id: 'a', embedding: [1, 0, 0] });
      await flush(instance);

      add(instance, { id: 'b', embedding: [0, 1, 0] });
      await flush(instance);

      add(instance, { id: 'c', embedding: [0, 0, 1] });
      await flush(instance);

      const instance2 = await create({ dimensions: 3, storageDriver: driver, collectionId: 'waltest', autoFlush: false });
      expect(instance2.entries.size).toBe(3);
    });

    it('addMany buffers all operations to WAL', async () => {
      const driver = createConcurrentFileDriver({ directory: dir, wal: true });
      const instance = await create({ dimensions: 3, storageDriver: driver, collectionId: 'waltest', autoFlush: false });

      addMany(instance, [
        { id: 'x', embedding: [1, 2, 3], context: { tag: 'batch' } },
        { id: 'y', embedding: [4, 5, 6] },
        { id: 'z', embedding: [7, 8, 9] },
      ]);
      await flush(instance);

      const instance2 = await create({ dimensions: 3, storageDriver: driver, collectionId: 'waltest', autoFlush: false });
      expect(instance2.entries.size).toBe(3);
      expect(get(instance2, 'x')!.context).toEqual({ tag: 'batch' });
    });

    it('works with INT8 quantization', async () => {
      const driver = createConcurrentFileDriver({ directory: dir, wal: true });
      const instance = await create({ dimensions: 3, quantization: 'INT8', storageDriver: driver, collectionId: 'waltest', autoFlush: false });

      add(instance, { id: 'a', embedding: [0.5, 0.3, 0.1] });
      await flush(instance);

      const instance2 = await create({ dimensions: 3, quantization: 'INT8', storageDriver: driver, collectionId: 'waltest', autoFlush: false });
      expect(stats(instance2).entryCount).toBe(1);
    });

    it('works with BIT quantization', async () => {
      const driver = createConcurrentFileDriver({ directory: dir, wal: true });
      const instance = await create({ dimensions: 8, quantization: 'BIT', metric: 'hamming', storageDriver: driver, collectionId: 'waltest', autoFlush: false });

      add(instance, { id: 'a', embedding: [1, 1, 1, 1, -1, -1, -1, -1] });
      await flush(instance);

      const instance2 = await create({ dimensions: 8, quantization: 'BIT', metric: 'hamming', storageDriver: driver, collectionId: 'waltest', autoFlush: false });
      expect(stats(instance2).entryCount).toBe(1);
    });

    it('query results match after WAL persist + restore', async () => {
      const driver = createConcurrentFileDriver({ directory: dir, wal: true });
      const instance = await create({ dimensions: 3, metric: 'cosine', storageDriver: driver, collectionId: 'waltest', autoFlush: false });

      add(instance, { id: 'cat', embedding: [1, 0, 0] });
      add(instance, { id: 'dog', embedding: [0.9, 0.1, 0] });
      add(instance, { id: 'car', embedding: [0, 0, 1] });

      const originalResults = query(instance, { vector: [1, 0, 0], topK: 2 });
      await flush(instance);

      const instance2 = await create({ dimensions: 3, metric: 'cosine', storageDriver: driver, collectionId: 'waltest', autoFlush: false });
      const restoredResults = query(instance2, { vector: [1, 0, 0], topK: 2 });
      expect(restoredResults).toEqual(originalResults);
    });

    it('delete collection removes WAL file too', async () => {
      const driver = createConcurrentFileDriver({ directory: dir, wal: true });
      const instance = await create({ dimensions: 3, storageDriver: driver, collectionId: 'waltest', autoFlush: false });

      add(instance, { id: 'a', embedding: [1, 0, 0] });
      await flush(instance);

      await driver.delete('waltest');

      // Both base and WAL files should be gone
      await expect(access(join(dir, 'waltest.trovec'))).rejects.toThrow();
      await expect(access(join(dir, 'waltest.trovec.wal'))).rejects.toThrow();
    });
  });

  describe('WAL with base file + incremental updates', () => {
    it('writes base file first, then WAL appends work', async () => {
      // First create a base file using non-WAL mode
      const baseDriver = createConcurrentFileDriver({ directory: dir });
      const instance1 = await create({ dimensions: 3, storageDriver: baseDriver, collectionId: 'hybrid', autoFlush: false });
      add(instance1, { id: 'base-1', embedding: [1, 0, 0] });
      await flush(instance1);

      // Now open with WAL mode — should load base and allow WAL appends
      const walDriver = createConcurrentFileDriver({ directory: dir, wal: true });
      const instance2 = await create({ dimensions: 3, storageDriver: walDriver, collectionId: 'hybrid', autoFlush: false });
      expect(instance2.entries.size).toBe(1);

      add(instance2, { id: 'wal-1', embedding: [0, 1, 0] });
      await flush(instance2);

      // Reload — should have both base and WAL entries
      const instance3 = await create({ dimensions: 3, storageDriver: walDriver, collectionId: 'hybrid', autoFlush: false });
      expect(instance3.entries.size).toBe(2);
      expect(get(instance3, 'base-1')!.embedding).toEqual([1, 0, 0]);
      expect(get(instance3, 'wal-1')!.embedding).toEqual([0, 1, 0]);
    });
  });
});
