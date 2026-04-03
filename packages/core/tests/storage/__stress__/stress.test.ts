import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConcurrentFileDriver } from '../../../src/storage/concurrent-file.js';
import { create, flush, close } from '../../../src/core.js';
import { add, addMany, get } from '../../../src/collection.js';
import { serialize } from '../../../src/serialization.js';
import type { TrovecInstance } from '../../../src/types.js';

function randomEmbedding(dimensions: number): number[] {
  return Array.from({ length: dimensions }, () => Math.random() * 2 - 1);
}

async function measure<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, durationMs: performance.now() - start };
}

describe('Stress & load tests', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'trovec-stress-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('3.1 500 rapid add+flush cycles (WAL mode)', async () => {
    const driver = createConcurrentFileDriver({ directory: dir, wal: true });
    const instance = await create({
      dimensions: 3,
      storageDriver: driver,
      collectionId: 'rapid',
      autoFlush: false,
    });
    const inst = instance as unknown as TrovecInstance;

    const totalOps = 500;
    const { durationMs } = await measure(async () => {
      for (let i = 0; i < totalOps; i++) {
        add(inst, { id: `entry-${i}`, embedding: [i, i + 1, i + 2] });
        await flush(inst);
      }
    });

    const avgFlushMs = durationMs / totalOps;
    console.log(`3.1 Rapid flush: ${totalOps} cycles in ${durationMs.toFixed(0)}ms (avg ${avgFlushMs.toFixed(1)}ms/flush)`);

    // Verify all entries survive
    await close(inst);
    const driver2 = createConcurrentFileDriver({ directory: dir, wal: true });
    const instance2 = await create({
      dimensions: 3,
      storageDriver: driver2,
      collectionId: 'rapid',
      autoFlush: false,
    });
    expect((instance2 as unknown as TrovecInstance).entries.size).toBe(totalOps);
  });

  it('3.2 1000 WAL entries without checkpoint -- measure read degradation', async () => {
    const driver = createConcurrentFileDriver({ directory: dir, wal: true });
    const instance = await create({
      dimensions: 3,
      storageDriver: driver,
      collectionId: 'walsize',
      autoFlush: false,
    });
    const inst = instance as unknown as TrovecInstance;

    const totalEntries = 1000;

    // First flush creates base file
    add(inst, { id: 'seed', embedding: [0, 0, 0] });
    await flush(inst);

    // 999 more entries via WAL
    for (let i = 1; i < totalEntries; i++) {
      add(inst, { id: `entry-${i}`, embedding: [i, i + 1, i + 2] });
      await flush(inst);
    }

    // Measure read time with large WAL
    const { durationMs: readWithWal } = await measure(async () => {
      const d = createConcurrentFileDriver({ directory: dir, wal: true });
      const i = await create({ dimensions: 3, storageDriver: d, collectionId: 'walsize', autoFlush: false });
      expect((i as unknown as TrovecInstance).entries.size).toBe(totalEntries);
    });

    // Checkpoint
    await driver.checkpoint('walsize', serialize(inst));

    // Measure read time after checkpoint
    const { durationMs: readAfterCheckpoint } = await measure(async () => {
      const d = createConcurrentFileDriver({ directory: dir, wal: true });
      const i = await create({ dimensions: 3, storageDriver: d, collectionId: 'walsize', autoFlush: false });
      expect((i as unknown as TrovecInstance).entries.size).toBe(totalEntries);
    });

    console.log(`3.2 WAL read degradation:`);
    console.log(`  - Read with ${totalEntries} WAL entries: ${readWithWal.toFixed(0)}ms`);
    console.log(`  - Read after checkpoint: ${readAfterCheckpoint.toFixed(0)}ms`);
    console.log(`  - Ratio: ${(readWithWal / readAfterCheckpoint).toFixed(1)}x slower with WAL`);
  });

  it('3.3 large vectors (768, 1536, 3072 dimensions)', async () => {
    const dimensionSets = [768, 1536, 3072];
    const entriesPerSet = 100;

    for (const dims of dimensionSets) {
      const testDir = await mkdtemp(join(tmpdir(), `trovec-largevec-${dims}-`));
      try {
        const driver = createConcurrentFileDriver({ directory: testDir });
        const instance = await create({
          dimensions: dims,
          storageDriver: driver,
          collectionId: 'largevec',
          autoFlush: false,
        });
        const inst = instance as unknown as TrovecInstance;

        const entries = Array.from({ length: entriesPerSet }, (_, i) => ({
          id: `entry-${i}`,
          embedding: randomEmbedding(dims),
        }));

        const { durationMs: addTime } = await measure(async () => {
          addMany(inst, entries);
        });

        const { durationMs: flushTime } = await measure(async () => {
          await flush(inst);
        });

        const filePath = join(testDir, 'largevec.trovec');
        const fileStat = await stat(filePath);

        const { durationMs: readTime } = await measure(async () => {
          const d = createConcurrentFileDriver({ directory: testDir });
          const i = await create({
            dimensions: dims,
            storageDriver: d,
            collectionId: 'largevec',
            autoFlush: false,
          });
          expect((i as unknown as TrovecInstance).entries.size).toBe(entriesPerSet);
        });

        console.log(`3.3 Large vectors (${dims}d x ${entriesPerSet} entries):`);
        console.log(`  - Add: ${addTime.toFixed(0)}ms, Flush: ${flushTime.toFixed(0)}ms, Read: ${readTime.toFixed(0)}ms`);
        console.log(`  - File size: ${(fileStat.size / 1024).toFixed(1)}KB`);
      } finally {
        await rm(testDir, { recursive: true, force: true });
      }
    }
  });

  it('3.4 10K entries, 128 dimensions', async () => {
    const dims = 128;
    const totalEntries = 10_000;

    const driver = createConcurrentFileDriver({ directory: dir });
    const instance = await create({
      dimensions: dims,
      storageDriver: driver,
      collectionId: 'large',
      autoFlush: false,
    });
    const inst = instance as unknown as TrovecInstance;

    const entries = Array.from({ length: totalEntries }, (_, i) => ({
      id: `entry-${i}`,
      embedding: randomEmbedding(dims),
    }));

    const { durationMs: addTime } = await measure(async () => {
      addMany(inst, entries);
    });

    const { durationMs: flushTime } = await measure(async () => {
      await flush(inst);
    });

    const filePath = join(dir, 'large.trovec');
    const fileStat = await stat(filePath);

    const { durationMs: readTime } = await measure(async () => {
      const d = createConcurrentFileDriver({ directory: dir });
      const i = await create({
        dimensions: dims,
        storageDriver: d,
        collectionId: 'large',
        autoFlush: false,
      });
      expect((i as unknown as TrovecInstance).entries.size).toBe(totalEntries);
    });

    console.log(`3.4 Large dataset (${totalEntries} x ${dims}d):`);
    console.log(`  - Add: ${addTime.toFixed(0)}ms, Flush: ${flushTime.toFixed(0)}ms, Read: ${readTime.toFixed(0)}ms`);
    console.log(`  - File size: ${(fileStat.size / 1024 / 1024).toFixed(2)}MB`);
  });

  it('3.5 50K entries, 128 dimensions', async () => {
    const dims = 128;
    const totalEntries = 50_000;

    const driver = createConcurrentFileDriver({ directory: dir });
    const instance = await create({
      dimensions: dims,
      storageDriver: driver,
      collectionId: 'xlarge',
      autoFlush: false,
    });
    const inst = instance as unknown as TrovecInstance;

    const entries = Array.from({ length: totalEntries }, (_, i) => ({
      id: `entry-${i}`,
      embedding: randomEmbedding(dims),
    }));

    const { durationMs: addTime } = await measure(async () => {
      addMany(inst, entries);
    });

    const { durationMs: flushTime } = await measure(async () => {
      await flush(inst);
    });

    const filePath = join(dir, 'xlarge.trovec');
    const fileStat = await stat(filePath);

    const { durationMs: readTime } = await measure(async () => {
      const d = createConcurrentFileDriver({ directory: dir });
      const i = await create({
        dimensions: dims,
        storageDriver: d,
        collectionId: 'xlarge',
        autoFlush: false,
      });
      expect((i as unknown as TrovecInstance).entries.size).toBe(totalEntries);
    });

    console.log(`3.5 XLarge dataset (${totalEntries} x ${dims}d):`);
    console.log(`  - Add: ${addTime.toFixed(0)}ms, Flush: ${flushTime.toFixed(0)}ms, Read: ${readTime.toFixed(0)}ms`);
    console.log(`  - File size: ${(fileStat.size / 1024 / 1024).toFixed(2)}MB`);
  });

  it('3.6 1000 direct WAL appends -- throughput', async () => {
    const driver = createConcurrentFileDriver({ directory: dir, wal: true });
    const instance = await create({
      dimensions: 3,
      storageDriver: driver,
      collectionId: 'throughput',
      autoFlush: false,
    });
    const inst = instance as unknown as TrovecInstance;

    // First flush to create base file and learn config
    add(inst, { id: 'seed', embedding: [0, 0, 0] });
    await flush(inst);

    const totalAppends = 1000;
    const { durationMs } = await measure(async () => {
      for (let i = 0; i < totalAppends; i++) {
        add(inst, { id: `wal-${i}`, embedding: [i, i + 1, i + 2] });
        await flush(inst);
      }
    });

    const entriesPerSec = (totalAppends / durationMs) * 1000;
    console.log(`3.6 WAL append throughput: ${totalAppends} appends in ${durationMs.toFixed(0)}ms (${entriesPerSec.toFixed(0)} entries/sec)`);
  });

  it('3.7 10 async tasks, 100 cycles each -- sustained contention', async () => {
    const driver = createConcurrentFileDriver({ directory: dir, wal: true });
    const instance = await create({
      dimensions: 3,
      storageDriver: driver,
      collectionId: 'contention',
      autoFlush: false,
    });
    const inst = instance as unknown as TrovecInstance;

    const taskCount = 10;
    const cyclesPerTask = 100;

    const { durationMs } = await measure(async () => {
      const tasks = Array.from({ length: taskCount }, async (_, taskIdx) => {
        for (let cycle = 0; cycle < cyclesPerTask; cycle++) {
          add(inst, {
            id: `task${taskIdx}-cycle${cycle}`,
            embedding: [taskIdx, cycle, taskIdx + cycle],
          });
          await flush(inst);
        }
      });
      await Promise.all(tasks);
    });

    console.log(`3.7 Sustained contention: ${taskCount} tasks x ${cyclesPerTask} cycles = ${taskCount * cyclesPerTask} ops in ${durationMs.toFixed(0)}ms`);

    // Verify data integrity -- all entries should be present
    const entryCount = inst.entries.size;
    expect(entryCount).toBe(taskCount * cyclesPerTask);
  });
});
