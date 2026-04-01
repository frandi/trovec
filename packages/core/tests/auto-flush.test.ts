import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { create, flush, close } from '../src/core.js';
import { add, addMany, del } from '../src/collection.js';
import { createMemoryDriver } from '../src/storage/memory.js';
import type { Trovec } from '../src/types.js';

describe('auto-flush', () => {
  const instances: Trovec[] = [];

  async function createTracked(...args: Parameters<typeof create>): Promise<Trovec> {
    const db = await create(...args);
    instances.push(db);
    return db;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    // Clean up beforeExit handlers from all instances
    for (const db of instances) {
      if (db._beforeExitHandler) {
        process.removeListener('beforeExit', db._beforeExitHandler);
        db._beforeExitHandler = undefined;
      }
      if (db._flushTimer != null) {
        clearTimeout(db._flushTimer);
        db._flushTimer = undefined;
      }
      db._scheduleFlush = undefined;
    }
    instances.length = 0;
    vi.useRealTimers();
  });

  it('auto-flushes after debounce delay', async () => {
    const driver = createMemoryDriver();
    const db = await createTracked({
      dimensions: 2,
      storageDriver: driver,
      collectionId: 'test',
    });

    db.add({ id: 'a', embedding: [1, 2] });
    expect(db.dirty).toBe(true);
    expect(await driver.exists('test')).toBe(false);

    // Advance past the default 500ms debounce
    await vi.advanceTimersByTimeAsync(500);

    expect(db.dirty).toBe(false);
    expect(await driver.exists('test')).toBe(true);
  });

  it('debounces multiple rapid mutations into a single flush', async () => {
    const driver = createMemoryDriver();
    const writeSpy = vi.spyOn(driver, 'write');
    const db = await createTracked({
      dimensions: 2,
      storageDriver: driver,
      collectionId: 'test',
    });

    db.add({ id: 'a', embedding: [1, 2] });
    db.add({ id: 'b', embedding: [3, 4] });
    db.add({ id: 'c', embedding: [5, 6] });

    await vi.advanceTimersByTimeAsync(500);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(db.dirty).toBe(false);
  });

  it('resets debounce timer on each mutation', async () => {
    const driver = createMemoryDriver();
    const writeSpy = vi.spyOn(driver, 'write');
    const db = await createTracked({
      dimensions: 2,
      storageDriver: driver,
      collectionId: 'test',
    });

    db.add({ id: 'a', embedding: [1, 2] });

    // Advance 400ms (not yet at 500ms threshold)
    await vi.advanceTimersByTimeAsync(400);
    expect(writeSpy).not.toHaveBeenCalled();

    // Add another entry — resets the timer
    db.add({ id: 'b', embedding: [3, 4] });

    // Advance another 400ms (800ms total, but only 400ms since last mutation)
    await vi.advanceTimersByTimeAsync(400);
    expect(writeSpy).not.toHaveBeenCalled();

    // Advance the remaining 100ms to hit 500ms since last mutation
    await vi.advanceTimersByTimeAsync(100);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('supports custom debounce delay', async () => {
    const driver = createMemoryDriver();
    const writeSpy = vi.spyOn(driver, 'write');
    const db = await createTracked({
      dimensions: 2,
      storageDriver: driver,
      collectionId: 'test',
      autoFlush: 2000,
    });

    db.add({ id: 'a', embedding: [1, 2] });

    await vi.advanceTimersByTimeAsync(500);
    expect(writeSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('does not auto-flush when autoFlush is false', async () => {
    const driver = createMemoryDriver();
    const writeSpy = vi.spyOn(driver, 'write');
    const db = await createTracked({
      dimensions: 2,
      storageDriver: driver,
      collectionId: 'test',
      autoFlush: false,
    });

    db.add({ id: 'a', embedding: [1, 2] });

    await vi.advanceTimersByTimeAsync(5000);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(db.dirty).toBe(true);
  });

  it('does not auto-flush without a storage driver', async () => {
    const db = await createTracked({ dimensions: 2 });

    db.add({ id: 'a', embedding: [1, 2] });

    await vi.advanceTimersByTimeAsync(5000);
    // Should not throw; dirty flag remains since no driver
    expect(db.dirty).toBe(true);
  });

  it('triggers auto-flush on addMany', async () => {
    const driver = createMemoryDriver();
    const db = await createTracked({
      dimensions: 2,
      storageDriver: driver,
      collectionId: 'test',
    });

    db.addMany([
      { id: 'a', embedding: [1, 2] },
      { id: 'b', embedding: [3, 4] },
    ]);

    await vi.advanceTimersByTimeAsync(500);
    expect(db.dirty).toBe(false);
    expect(await driver.exists('test')).toBe(true);
  });

  it('triggers auto-flush on delete', async () => {
    const driver = createMemoryDriver();
    const db = await createTracked({
      dimensions: 2,
      storageDriver: driver,
      collectionId: 'test',
      autoFlush: false,
    });

    db.add({ id: 'a', embedding: [1, 2] });
    await flush(db);

    // Re-create with auto-flush enabled
    const db2 = await createTracked({
      dimensions: 2,
      storageDriver: driver,
      collectionId: 'test',
    });

    db2.delete('a');
    expect(db2.dirty).toBe(true);

    await vi.advanceTimersByTimeAsync(500);
    expect(db2.dirty).toBe(false);
  });

  it('manual flush clears debounce timer', async () => {
    const driver = createMemoryDriver();
    const writeSpy = vi.spyOn(driver, 'write');
    const db = await createTracked({
      dimensions: 2,
      storageDriver: driver,
      collectionId: 'test',
    });

    db.add({ id: 'a', embedding: [1, 2] });
    await db.flush();

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(db.dirty).toBe(false);

    // The debounce timer should have been cleared by flush
    await vi.advanceTimersByTimeAsync(500);
    expect(writeSpy).toHaveBeenCalledTimes(1); // No extra flush
  });

  it('auto-flush errors do not crash the instance', async () => {
    const driver = createMemoryDriver();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(driver, 'write').mockRejectedValueOnce(new Error('disk full'));

    const db = await createTracked({
      dimensions: 2,
      storageDriver: driver,
      collectionId: 'test',
    });

    db.add({ id: 'a', embedding: [1, 2] });

    await vi.advanceTimersByTimeAsync(500);

    // Instance still works
    expect(db.dirty).toBe(true); // dirty because flush failed
    expect(warnSpy).toHaveBeenCalledWith('Trovec auto-flush failed:', expect.any(Error));

    warnSpy.mockRestore();
  });

  describe('close()', () => {
    it('flushes pending changes and disables auto-flush', async () => {
      const driver = createMemoryDriver();
      const db = await createTracked({
        dimensions: 2,
        storageDriver: driver,
        collectionId: 'test',
      });

      db.add({ id: 'a', embedding: [1, 2] });
      expect(db.dirty).toBe(true);

      await db.close();

      expect(db.dirty).toBe(false);
      expect(await driver.exists('test')).toBe(true);

      // Further mutations should not schedule auto-flush
      db.add({ id: 'b', embedding: [3, 4] });
      await vi.advanceTimersByTimeAsync(5000);
      // dirty remains because auto-flush is disabled after close
      expect(db.dirty).toBe(true);
    });

    it('is safe to call when instance is clean', async () => {
      const driver = createMemoryDriver();
      const writeSpy = vi.spyOn(driver, 'write');
      const db = await createTracked({
        dimensions: 2,
        storageDriver: driver,
        collectionId: 'test',
      });

      await db.close();
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it('clears pending debounce timer before flushing', async () => {
      const driver = createMemoryDriver();
      const writeSpy = vi.spyOn(driver, 'write');
      const db = await createTracked({
        dimensions: 2,
        storageDriver: driver,
        collectionId: 'test',
      });

      db.add({ id: 'a', embedding: [1, 2] });
      // Timer is now scheduled

      await db.close();
      // Only one flush from close(), not a second from the timer
      expect(writeSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);
      expect(writeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('flush mutex', () => {
    it('serializes concurrent flush calls', async () => {
      const driver = createMemoryDriver();
      let writeCount = 0;
      vi.spyOn(driver, 'write').mockImplementation(async () => {
        writeCount++;
        // Simulate slow write
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      const db = await createTracked({
        dimensions: 2,
        storageDriver: driver,
        collectionId: 'test',
        autoFlush: false,
      });

      db.add({ id: 'a', embedding: [1, 2] });

      // Start two flushes concurrently
      const p1 = db.flush();
      const p2 = db.flush();

      await vi.advanceTimersByTimeAsync(200);
      await p1;
      await p2;

      // Both should complete (second waits for first)
      expect(writeCount).toBe(2);
    });
  });

  describe('data roundtrip with auto-flush', () => {
    it('auto-flushed data can be loaded by a new instance', async () => {
      const driver = createMemoryDriver();
      const db = await createTracked({
        dimensions: 2,
        storageDriver: driver,
        collectionId: 'roundtrip',
      });

      db.add({ id: 'x', embedding: [1, 2], context: { tag: 'hello' } });

      await vi.advanceTimersByTimeAsync(500);

      // Create a new instance with same collection — should auto-load
      const db2 = await createTracked({
        dimensions: 2,
        storageDriver: driver,
        collectionId: 'roundtrip',
      });

      expect(db2.stats().entryCount).toBe(1);
      const entry = db2.get('x');
      expect(entry).toBeDefined();
      expect(entry!.embedding).toEqual([1, 2]);
      expect(entry!.context).toEqual({ tag: 'hello' });
    });
  });

  describe('beforeExit safety net', () => {
    it('registers a beforeExit handler when auto-flush is enabled', async () => {
      const driver = createMemoryDriver();
      const db = await createTracked({
        dimensions: 2,
        storageDriver: driver,
        collectionId: 'test',
      });

      expect(db._beforeExitHandler).toBeTypeOf('function');
      await db.close();
    });

    it('does not register beforeExit handler when auto-flush is disabled', async () => {
      const db = await createTracked({
        dimensions: 2,
        autoFlush: false,
      });

      expect(db._beforeExitHandler).toBeUndefined();
    });

    it('close() removes the beforeExit handler', async () => {
      const driver = createMemoryDriver();
      const db = await createTracked({
        dimensions: 2,
        storageDriver: driver,
        collectionId: 'test',
      });

      expect(db._beforeExitHandler).toBeTypeOf('function');
      await db.close();
      expect(db._beforeExitHandler).toBeUndefined();
    });

    it('beforeExit handler flushes dirty data', async () => {
      const driver = createMemoryDriver();
      const db = await createTracked({
        dimensions: 2,
        storageDriver: driver,
        collectionId: 'test',
      });

      db.add({ id: 'a', embedding: [1, 2] });
      expect(db.dirty).toBe(true);

      // Simulate beforeExit by calling the handler directly
      db._beforeExitHandler!();

      // The handler fires flush() asynchronously — advance timers to let it resolve
      await vi.advanceTimersByTimeAsync(0);
      await db._flushing;

      expect(db.dirty).toBe(false);
      expect(await driver.exists('test')).toBe(true);

      await db.close();
    });

    it('beforeExit handler is a no-op when not dirty', async () => {
      const driver = createMemoryDriver();
      const writeSpy = vi.spyOn(driver, 'write');
      const db = await createTracked({
        dimensions: 2,
        storageDriver: driver,
        collectionId: 'test',
      });

      // Not dirty — handler should do nothing
      db._beforeExitHandler!();
      await vi.advanceTimersByTimeAsync(0);

      expect(writeSpy).not.toHaveBeenCalled();
      await db.close();
    });

    it('debounce timer is unref-ed so it does not keep process alive', async () => {
      const driver = createMemoryDriver();
      const db = await createTracked({
        dimensions: 2,
        storageDriver: driver,
        collectionId: 'test',
      });

      db.add({ id: 'a', embedding: [1, 2] });

      // The timer should exist and have been unref'd
      // We verify indirectly: the timer has a .ref/.unref method and hasRef() returns false
      expect(db._flushTimer).toBeDefined();
      expect(db._flushTimer!.hasRef()).toBe(false);

      await db.close();
    });
  });

  describe('config validation', () => {
    it('rejects negative autoFlush delay', async () => {
      await expect(
        create({ dimensions: 2, autoFlush: -100 })
      ).rejects.toThrow('autoFlush delay must be a positive number');
    });

    it('rejects zero autoFlush delay', async () => {
      await expect(
        create({ dimensions: 2, autoFlush: 0 })
      ).rejects.toThrow('autoFlush delay must be a positive number');
    });
  });
});
