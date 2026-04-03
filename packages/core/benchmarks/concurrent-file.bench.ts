/**
 * Performance benchmarks for the concurrent file driver.
 *
 * Run: npm run test:bench --workspace=packages/core
 * (or: npx tsx benchmarks/concurrent-file.bench.ts)
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConcurrentFileDriver } from '../src/storage/concurrent-file.js';
import { create, flush, close } from '../src/core.js';
import { add, addMany } from '../src/collection.js';
import { serialize } from '../src/serialization.js';
import type { TrovecInstance } from '../src/types.js';

function randomEmbedding(dims: number): number[] {
  return Array.from({ length: dims }, () => Math.random() * 2 - 1);
}

async function measure<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, durationMs: performance.now() - start };
}

async function median(fn: () => Promise<number>, runs = 5): Promise<number> {
  const results: number[] = [];
  for (let i = 0; i < runs; i++) {
    results.push(await fn());
  }
  results.sort((a, b) => a - b);
  return results[Math.floor(results.length / 2)];
}

// ============================================================================
// 4.1 Single-process add throughput
// ============================================================================
async function bench41(): Promise<void> {
  console.log('\n## 4.1 Single-process add throughput\n');
  console.log('| Dimensions | Batch Size | Add (ms) | Flush (ms) | Total (ms) | Adds/sec |');
  console.log('|------------|------------|----------|------------|------------|----------|');

  for (const dims of [128, 384, 768]) {
    for (const batchSize of [1, 10, 100, 1000]) {
      const dir = await mkdtemp(join(tmpdir(), 'trovec-bench-'));
      try {
        const driver = createConcurrentFileDriver({ directory: dir });
        const instance = await create({
          dimensions: dims,
          storageDriver: driver,
          collectionId: 'bench',
          autoFlush: false,
        });
        const inst = instance as unknown as TrovecInstance;

        const entries = Array.from({ length: batchSize }, (_, i) => ({
          id: `e-${i}`,
          embedding: randomEmbedding(dims),
        }));

        const { durationMs: addMs } = await measure(async () => {
          addMany(inst, entries);
        });

        const { durationMs: flushMs } = await measure(async () => {
          await flush(inst);
        });

        const totalMs = addMs + flushMs;
        const addsPerSec = (batchSize / totalMs) * 1000;

        console.log(
          `| ${dims} | ${batchSize} | ${addMs.toFixed(1)} | ${flushMs.toFixed(1)} | ${totalMs.toFixed(1)} | ${addsPerSec.toFixed(0)} |`,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
}

// ============================================================================
// 4.2 WAL append latency vs full write
// ============================================================================
async function bench42(): Promise<void> {
  console.log('\n## 4.2 WAL append latency vs full write\n');
  console.log('| Collection Size | WAL Append (ms) | Full Write (ms) | Speedup |');
  console.log('|-----------------|-----------------|-----------------|---------|');

  for (const collectionSize of [10, 100, 1_000, 10_000]) {
    const dir = await mkdtemp(join(tmpdir(), 'trovec-bench-'));
    try {
      // Set up collection with WAL
      const walDriver = createConcurrentFileDriver({ directory: dir, wal: true });
      const walInstance = await create({
        dimensions: 128,
        storageDriver: walDriver,
        collectionId: 'bench-wal',
        autoFlush: false,
      });
      const walInst = walInstance as unknown as TrovecInstance;

      // Populate
      addMany(walInst, Array.from({ length: collectionSize }, (_, i) => ({
        id: `e-${i}`,
        embedding: randomEmbedding(128),
      })));
      await flush(walInst);

      // Measure WAL append (median of 5)
      const walMs = await median(async () => {
        add(walInst, { id: `wal-${Date.now()}`, embedding: randomEmbedding(128) });
        const { durationMs } = await measure(async () => { await flush(walInst); });
        return durationMs;
      });

      // Set up collection without WAL for full write comparison
      const fullDriver = createConcurrentFileDriver({ directory: dir });
      const fullInstance = await create({
        dimensions: 128,
        storageDriver: fullDriver,
        collectionId: 'bench-full',
        autoFlush: false,
      });
      const fullInst = fullInstance as unknown as TrovecInstance;

      addMany(fullInst, Array.from({ length: collectionSize }, (_, i) => ({
        id: `e-${i}`,
        embedding: randomEmbedding(128),
      })));
      await flush(fullInst);

      // Measure full write (median of 5)
      const fullMs = await median(async () => {
        add(fullInst, { id: `full-${Date.now()}`, embedding: randomEmbedding(128) });
        const { durationMs } = await measure(async () => { await flush(fullInst); });
        return durationMs;
      });

      const speedup = fullMs / walMs;
      console.log(
        `| ${collectionSize} | ${walMs.toFixed(1)} | ${fullMs.toFixed(1)} | ${speedup.toFixed(1)}x |`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

// ============================================================================
// 4.3 Read latency with growing WAL size
// ============================================================================
async function bench43(): Promise<void> {
  console.log('\n## 4.3 Read latency with growing WAL\n');
  console.log('| WAL Entries | Read (ms) |');
  console.log('|-------------|-----------|');

  const dir = await mkdtemp(join(tmpdir(), 'trovec-bench-'));
  try {
    const driver = createConcurrentFileDriver({ directory: dir, wal: true });
    const instance = await create({
      dimensions: 128,
      storageDriver: driver,
      collectionId: 'bench',
      autoFlush: false,
    });
    const inst = instance as unknown as TrovecInstance;

    // Create base with 1000 entries
    addMany(inst, Array.from({ length: 1000 }, (_, i) => ({
      id: `base-${i}`,
      embedding: randomEmbedding(128),
    })));
    await flush(inst);

    // Progressively add WAL entries and measure read
    const tiers = [0, 10, 50, 100, 500, 1000];
    let walCount = 0;

    for (const tier of tiers) {
      const toAdd = tier - walCount;
      for (let i = 0; i < toAdd; i++) {
        add(inst, { id: `wal-${walCount + i}`, embedding: randomEmbedding(128) });
        await flush(inst);
      }
      walCount = tier;

      const readMs = await median(async () => {
        const d = createConcurrentFileDriver({ directory: dir, wal: true });
        const { durationMs } = await measure(async () => {
          await create({ dimensions: 128, storageDriver: d, collectionId: 'bench', autoFlush: false });
        });
        return durationMs;
      }, 3);

      console.log(`| ${tier} | ${readMs.toFixed(1)} |`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ============================================================================
// 4.4 Checkpoint duration vs WAL size
// ============================================================================
async function bench44(): Promise<void> {
  console.log('\n## 4.4 Checkpoint duration vs WAL size\n');
  console.log('| WAL Entries | Checkpoint (ms) |');
  console.log('|-------------|-----------------|');

  const tiers = [10, 100, 500, 1000];

  for (const tier of tiers) {
    const dir = await mkdtemp(join(tmpdir(), 'trovec-bench-'));
    try {
      const driver = createConcurrentFileDriver({ directory: dir, wal: true });
      const instance = await create({
        dimensions: 128,
        storageDriver: driver,
        collectionId: 'bench',
        autoFlush: false,
      });
      const inst = instance as unknown as TrovecInstance;

      // Create base
      addMany(inst, Array.from({ length: 1000 }, (_, i) => ({
        id: `base-${i}`,
        embedding: randomEmbedding(128),
      })));
      await flush(inst);

      // Add WAL entries
      for (let i = 0; i < tier; i++) {
        add(inst, { id: `wal-${i}`, embedding: randomEmbedding(128) });
        await flush(inst);
      }

      // Measure checkpoint
      const { durationMs } = await measure(async () => {
        await driver.checkpoint('bench', serialize(inst));
      });

      console.log(`| ${tier} | ${durationMs.toFixed(1)} |`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

// ============================================================================
// 4.5 File size analysis
// ============================================================================
async function bench45(): Promise<void> {
  console.log('\n## 4.5 File size analysis (1K entries)\n');
  console.log('| Dimensions | Quantization | Compressed (KB) | Uncompressed (KB) | Ratio |');
  console.log('|------------|--------------|-----------------|-------------------|-------|');

  for (const dims of [128, 384, 768]) {
    for (const quant of ['F32', 'INT8'] as const) {
      const entries = Array.from({ length: 1000 }, (_, i) => ({
        id: `e-${i}`,
        embedding: randomEmbedding(dims),
      }));

      // Compressed
      const dirComp = await mkdtemp(join(tmpdir(), 'trovec-bench-'));
      const driverComp = createConcurrentFileDriver({ directory: dirComp, compression: true });
      const instComp = await create({
        dimensions: dims,
        quantization: quant,
        storageDriver: driverComp,
        collectionId: 'bench',
        autoFlush: false,
      });
      addMany(instComp as unknown as TrovecInstance, entries);
      await flush(instComp as unknown as TrovecInstance);
      const compSize = (await stat(join(dirComp, 'bench.trovec'))).size;

      // Uncompressed
      const dirRaw = await mkdtemp(join(tmpdir(), 'trovec-bench-'));
      const driverRaw = createConcurrentFileDriver({ directory: dirRaw, compression: false });
      const instRaw = await create({
        dimensions: dims,
        quantization: quant,
        storageDriver: driverRaw,
        collectionId: 'bench',
        autoFlush: false,
      });
      addMany(instRaw as unknown as TrovecInstance, entries);
      await flush(instRaw as unknown as TrovecInstance);
      const rawSize = (await stat(join(dirRaw, 'bench.trovec'))).size;

      const ratio = rawSize / compSize;
      console.log(
        `| ${dims} | ${quant} | ${(compSize / 1024).toFixed(1)} | ${(rawSize / 1024).toFixed(1)} | ${ratio.toFixed(1)}x |`,
      );

      await rm(dirComp, { recursive: true, force: true });
      await rm(dirRaw, { recursive: true, force: true });
    }
  }
}

// ============================================================================
// 4.6 Memory usage
// ============================================================================
async function bench46(): Promise<void> {
  console.log('\n## 4.6 Memory usage\n');
  console.log('| Entries | Dimensions | Heap Before (MB) | Heap After (MB) | Delta (MB) |');
  console.log('|---------|------------|------------------|-----------------|------------|');

  for (const [count, dims] of [[10_000, 128], [50_000, 128], [10_000, 768]] as const) {
    const dir = await mkdtemp(join(tmpdir(), 'trovec-bench-'));
    try {
      // Create and flush data
      const driver = createConcurrentFileDriver({ directory: dir });
      const inst = await create({
        dimensions: dims,
        storageDriver: driver,
        collectionId: 'bench',
        autoFlush: false,
      });
      addMany(inst as unknown as TrovecInstance, Array.from({ length: count }, (_, i) => ({
        id: `e-${i}`,
        embedding: randomEmbedding(dims),
      })));
      await flush(inst as unknown as TrovecInstance);
      await close(inst as unknown as TrovecInstance);

      // Force GC if available
      if (global.gc) global.gc();

      const heapBefore = process.memoryUsage().heapUsed / 1024 / 1024;

      // Load from disk
      const driver2 = createConcurrentFileDriver({ directory: dir });
      const inst2 = await create({
        dimensions: dims,
        storageDriver: driver2,
        collectionId: 'bench',
        autoFlush: false,
      });
      expect((inst2 as unknown as TrovecInstance).entries.size).toBe(count);

      const heapAfter = process.memoryUsage().heapUsed / 1024 / 1024;

      console.log(
        `| ${count} | ${dims} | ${heapBefore.toFixed(1)} | ${heapAfter.toFixed(1)} | ${(heapAfter - heapBefore).toFixed(1)} |`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

// ============================================================================
// Main
// ============================================================================
async function main(): Promise<void> {
  console.log('# Trovec Concurrent File Driver Benchmarks');
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Node: ${process.version}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);

  await bench41();
  await bench42();
  await bench43();
  await bench44();
  await bench45();
  await bench46();

  console.log('\n---\nBenchmarks complete.');
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
