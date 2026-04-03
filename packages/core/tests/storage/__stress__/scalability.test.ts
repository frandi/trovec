import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createConcurrentFileDriver } from '../../../src/storage/concurrent-file.js';
import { create, flush, close } from '../../../src/core.js';
import { add, addMany } from '../../../src/collection.js';
import { query } from '../../../src/query.js';
import { serialize } from '../../../src/serialization.js';
import type { TrovecInstance } from '../../../src/types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const WORKER_PATH = join(__dirname, '..', '..', 'fixtures', 'worker.ts');

function randomEmbedding(dimensions: number): number[] {
  return Array.from({ length: dimensions }, () => Math.random() * 2 - 1);
}

async function measure<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, durationMs: performance.now() - start };
}

interface WorkerResult {
  type: 'result';
  success: boolean;
  data?: unknown;
  error?: string;
}

function spawnWorker(): Promise<{ proc: ChildProcess; ready: Promise<void> }> {
  return new Promise((resolve) => {
    const proc = fork(WORKER_PATH, [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    const ready = new Promise<void>((readyResolve, readyReject) => {
      proc.once('message', (msg: WorkerResult) => {
        if (msg.success && msg.data === 'ready') readyResolve();
        else readyReject(new Error('Worker failed to start'));
      });
      proc.once('error', readyReject);
    });
    resolve({ proc, ready });
  });
}

function sendCommand(proc: ChildProcess, cmd: Record<string, unknown>): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const onMessage = (msg: WorkerResult) => {
      proc.removeListener('error', onError);
      resolve(msg);
    };
    const onError = (err: Error) => {
      proc.removeListener('message', onMessage);
      reject(err);
    };
    proc.once('message', onMessage);
    proc.once('error', onError);
    proc.send(cmd);
  });
}

describe('Scalability limit tests', () => {
  let dir: string;
  const workers: ChildProcess[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'trovec-scale-test-'));
  });

  afterEach(async () => {
    for (const w of workers) {
      try { w.kill('SIGKILL'); } catch { /* already dead */ }
    }
    workers.length = 0;
    await rm(dir, { recursive: true, force: true });
  });

  it('5.1 progressive dataset size (1K -> 100K, 128d)', async () => {
    const dims = 128;
    const tiers = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000];

    console.log(`\n5.1 Progressive dataset size (${dims}d, F32):`);
    console.log('  Entries  |  Add(ms)  |  Flush(ms)  |  Read(ms)  |  File(MB)');
    console.log('  ---------|-----------|-------------|------------|----------');

    for (const count of tiers) {
      const testDir = await mkdtemp(join(tmpdir(), `trovec-scale-${count}-`));
      try {
        const driver = createConcurrentFileDriver({ directory: testDir });
        const instance = await create({
          dimensions: dims,
          storageDriver: driver,
          collectionId: 'scale',
          autoFlush: false,
        });
        const inst = instance as unknown as TrovecInstance;

        const entries = Array.from({ length: count }, (_, i) => ({
          id: `e-${i}`,
          embedding: randomEmbedding(dims),
        }));

        const { durationMs: addMs } = await measure(async () => {
          addMany(inst, entries);
        });

        const { durationMs: flushMs } = await measure(async () => {
          await flush(inst);
        });

        const fileStat = await stat(join(testDir, 'scale.trovec'));
        const fileMB = fileStat.size / 1024 / 1024;

        const { durationMs: readMs } = await measure(async () => {
          const d = createConcurrentFileDriver({ directory: testDir });
          const i2 = await create({
            dimensions: dims,
            storageDriver: d,
            collectionId: 'scale',
            autoFlush: false,
          });
          expect((i2 as unknown as TrovecInstance).entries.size).toBe(count);
        });

        console.log(
          `  ${String(count).padStart(7)}  |  ${addMs.toFixed(0).padStart(7)}  |  ${flushMs.toFixed(0).padStart(9)}  |  ${readMs.toFixed(0).padStart(8)}  |  ${fileMB.toFixed(2).padStart(7)}`,
        );

        // Break early if operations are too slow
        if (flushMs > 10_000 || readMs > 10_000) {
          console.log(`  *** LIMIT REACHED at ${count} entries (flush or read > 10s) ***`);
          break;
        }
      } finally {
        await rm(testDir, { recursive: true, force: true });
      }
    }
  });

  it('5.2 WAL growth without checkpoint -- read degradation', async () => {
    const dims = 128;
    const baseEntries = 1000;
    const walTiers = [100, 500, 1_000, 5_000, 10_000];

    // Create base collection
    const driver = createConcurrentFileDriver({ directory: dir, wal: true });
    const instance = await create({
      dimensions: dims,
      storageDriver: driver,
      collectionId: 'walscale',
      autoFlush: false,
    });
    const inst = instance as unknown as TrovecInstance;

    addMany(inst, Array.from({ length: baseEntries }, (_, i) => ({
      id: `base-${i}`,
      embedding: randomEmbedding(dims),
    })));
    await flush(inst);

    console.log(`\n5.2 WAL growth (${baseEntries} base entries, ${dims}d):`);
    console.log('  WAL size  |  Read(ms)  |  WAL file(KB)');
    console.log('  ----------|------------|---------------');

    let walEntryCount = 0;
    for (const tier of walTiers) {
      // Add entries until we reach this tier
      const toAdd = tier - walEntryCount;
      for (let i = 0; i < toAdd; i++) {
        add(inst, {
          id: `wal-${walEntryCount + i}`,
          embedding: randomEmbedding(dims),
        });
        await flush(inst);
      }
      walEntryCount = tier;

      // Measure read time
      const { durationMs: readMs } = await measure(async () => {
        const d = createConcurrentFileDriver({ directory: dir, wal: true });
        const i2 = await create({
          dimensions: dims,
          storageDriver: d,
          collectionId: 'walscale',
          autoFlush: false,
        });
        expect((i2 as unknown as TrovecInstance).entries.size).toBe(baseEntries + tier);
      });

      let walFileKB = 0;
      try {
        const walStat = await stat(join(dir, 'walscale.trovec.wal'));
        walFileKB = walStat.size / 1024;
      } catch { /* no WAL yet */ }

      console.log(
        `  ${String(tier).padStart(8)}  |  ${readMs.toFixed(0).padStart(8)}  |  ${walFileKB.toFixed(1).padStart(13)}`,
      );

      if (readMs > 5_000) {
        console.log(`  *** READ DEGRADATION LIMIT at ${tier} WAL entries (>5s) ***`);
        break;
      }
    }
  });

  it('5.3 lock contention with N concurrent processes', async () => {
    const dims = 3;
    const opsPerWorker = 50;
    const processCounts = [2, 4, 8];

    console.log(`\n5.3 Lock contention scaling (${opsPerWorker} ops/worker, ${dims}d):`);
    console.log('  Processes  |  Total(ms)  |  Throughput(ops/s)');
    console.log('  -----------|-------------|-------------------');

    for (const N of processCounts) {
      const testDir = await mkdtemp(join(tmpdir(), `trovec-contention-${N}-`));
      try {
        const spawned: { proc: ChildProcess; ready: Promise<void> }[] = [];
        for (let i = 0; i < N; i++) {
          spawned.push(await spawnWorker());
        }
        const procs = spawned.map((s) => s.proc);
        workers.push(...procs);

        await Promise.all(spawned.map((s) => s.ready));
        await Promise.all(
          procs.map((proc) =>
            sendCommand(proc, {
              type: 'init',
              dir: testDir,
              collectionId: 'contend',
              dimensions: dims,
              wal: true,
              lockAcquireTimeout: 30_000,
            }),
          ),
        );

        const { durationMs } = await measure(async () => {
          await Promise.all(
            procs.map(async (proc, idx) => {
              for (let op = 0; op < opsPerWorker; op++) {
                await sendCommand(proc, {
                  type: 'add',
                  id: `p${idx}-op${op}`,
                  embedding: [idx, op, idx + op],
                });
                const res = await sendCommand(proc, { type: 'flush' });
                if (!res.success) throw new Error(`Flush failed: ${res.error}`);
              }
            }),
          );
        });

        const totalOps = N * opsPerWorker;
        const throughput = (totalOps / durationMs) * 1000;

        console.log(
          `  ${String(N).padStart(9)}  |  ${durationMs.toFixed(0).padStart(9)}  |  ${throughput.toFixed(1).padStart(17)}`,
        );

        // Cleanup workers for this iteration
        for (const proc of procs) {
          await sendCommand(proc, { type: 'close' }).catch(() => {});
          proc.kill('SIGTERM');
        }
        // Remove from workers array
        for (const proc of procs) {
          const idx = workers.indexOf(proc);
          if (idx >= 0) workers.splice(idx, 1);
        }
      } finally {
        await rm(testDir, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it('5.4 high-dimension stress (3072d x 10K entries)', async () => {
    const dims = 3072;
    const totalEntries = 10_000;

    const driver = createConcurrentFileDriver({ directory: dir });
    const instance = await create({
      dimensions: dims,
      storageDriver: driver,
      collectionId: 'hidim',
      autoFlush: false,
    });
    const inst = instance as unknown as TrovecInstance;

    console.log(`\n5.4 High-dimension stress (${dims}d x ${totalEntries} entries):`);

    const { durationMs: addMs } = await measure(async () => {
      // Add in batches of 1000 to avoid excessive memory pressure
      for (let batch = 0; batch < totalEntries / 1000; batch++) {
        const entries = Array.from({ length: 1000 }, (_, i) => ({
          id: `e-${batch * 1000 + i}`,
          embedding: randomEmbedding(dims),
        }));
        addMany(inst, entries);
      }
    });
    console.log(`  - Add: ${addMs.toFixed(0)}ms`);

    const { durationMs: flushMs } = await measure(async () => {
      await flush(inst);
    });

    const fileStat = await stat(join(dir, 'hidim.trovec'));
    console.log(`  - Flush: ${flushMs.toFixed(0)}ms`);
    console.log(`  - File size: ${(fileStat.size / 1024 / 1024).toFixed(2)}MB`);

    const { durationMs: readMs } = await measure(async () => {
      const d = createConcurrentFileDriver({ directory: dir });
      const i2 = await create({
        dimensions: dims,
        storageDriver: d,
        collectionId: 'hidim',
        autoFlush: false,
      });
      expect((i2 as unknown as TrovecInstance).entries.size).toBe(totalEntries);
    });
    console.log(`  - Read: ${readMs.toFixed(0)}ms`);

    // Query benchmark
    const { durationMs: queryMs } = await measure(async () => {
      query(inst, { vector: randomEmbedding(dims), topK: 10 });
    });
    console.log(`  - Query (top-10): ${queryMs.toFixed(0)}ms`);

    const memUsage = process.memoryUsage();
    console.log(`  - Heap used: ${(memUsage.heapUsed / 1024 / 1024).toFixed(1)}MB`);
  });

  it('5.5 INT8 vs F32 scaling (10K entries, 768d)', async () => {
    const dims = 768;
    const totalEntries = 10_000;

    console.log(`\n5.5 Quantization comparison (${totalEntries} x ${dims}d):`);
    console.log('  Quant  |  Add(ms)  |  Flush(ms)  |  Read(ms)  |  File(MB)');
    console.log('  -------|-----------|-------------|------------|----------');

    for (const quant of ['F32', 'INT8'] as const) {
      const testDir = await mkdtemp(join(tmpdir(), `trovec-quant-${quant}-`));
      try {
        const driver = createConcurrentFileDriver({ directory: testDir });
        const instance = await create({
          dimensions: dims,
          quantization: quant,
          storageDriver: driver,
          collectionId: 'quant',
          autoFlush: false,
        });
        const inst = instance as unknown as TrovecInstance;

        const entries = Array.from({ length: totalEntries }, (_, i) => ({
          id: `e-${i}`,
          embedding: randomEmbedding(dims),
        }));

        const { durationMs: addMs } = await measure(async () => {
          addMany(inst, entries);
        });

        const { durationMs: flushMs } = await measure(async () => {
          await flush(inst);
        });

        const fileStat = await stat(join(testDir, 'quant.trovec'));
        const fileMB = fileStat.size / 1024 / 1024;

        const { durationMs: readMs } = await measure(async () => {
          const d = createConcurrentFileDriver({ directory: testDir });
          const i2 = await create({
            dimensions: dims,
            quantization: quant,
            storageDriver: d,
            collectionId: 'quant',
            autoFlush: false,
          });
          expect((i2 as unknown as TrovecInstance).entries.size).toBe(totalEntries);
        });

        console.log(
          `  ${quant.padEnd(5)}  |  ${addMs.toFixed(0).padStart(7)}  |  ${flushMs.toFixed(0).padStart(9)}  |  ${readMs.toFixed(0).padStart(8)}  |  ${fileMB.toFixed(2).padStart(7)}`,
        );
      } finally {
        await rm(testDir, { recursive: true, force: true });
      }
    }
  });
});
