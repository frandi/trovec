import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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

const RESULTS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'results');

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computeStats(values: number[]): {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

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

    const datasetReport: Array<{ entries: number; addMs: number; flushMs: number; readMs: number; fileMB: number }> = [];

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

        const tierResult = { entries: count, addMs: Math.round(addMs), flushMs: Math.round(flushMs), readMs: Math.round(readMs), fileMB: Math.round(fileMB * 100) / 100 };
        datasetReport.push(tierResult);

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

    const { mkdir } = await import('node:fs/promises');
    await mkdir(RESULTS_DIR, { recursive: true });
    await writeFile(
      join(RESULTS_DIR, 'dataset-scaling.json'),
      JSON.stringify({
        test: '5.1',
        description: 'Progressive dataset size scaling',
        timestamp: new Date().toISOString(),
        config: { dims, quantization: 'F32' },
        tiers: datasetReport,
      }, null, 2),
    );
    console.log(`  Results written to tests/storage/__stress__/results/dataset-scaling.json`);
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

    const walReport: Array<{ walEntries: number; readMs: number; walFileKB: number }> = [];

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

      walReport.push({ walEntries: tier, readMs: Math.round(readMs), walFileKB: Math.round(walFileKB * 10) / 10 });

      console.log(
        `  ${String(tier).padStart(8)}  |  ${readMs.toFixed(0).padStart(8)}  |  ${walFileKB.toFixed(1).padStart(13)}`,
      );

      if (readMs > 5_000) {
        console.log(`  *** READ DEGRADATION LIMIT at ${tier} WAL entries (>5s) ***`);
        break;
      }
    }

    const { mkdir } = await import('node:fs/promises');
    await mkdir(RESULTS_DIR, { recursive: true });
    await writeFile(
      join(RESULTS_DIR, 'wal-scaling.json'),
      JSON.stringify({
        test: '5.2',
        description: 'WAL growth without checkpoint -- read degradation',
        timestamp: new Date().toISOString(),
        config: { dims, baseEntries },
        tiers: walReport,
      }, null, 2),
    );
    console.log(`  Results written to tests/storage/__stress__/results/wal-scaling.json`);
  });

  it('5.3 lock contention with N concurrent processes', async () => {
    const dims = 3;
    const opsPerWorker = 50;
    const processCounts = [2, 4, 8, 16, 32];
    const lockAcquireTimeout = 30_000;

    const report: Array<{
      processes: number;
      opsPerWorker: number;
      totalOps: number;
      totalMs: number;
      throughputOpsPerSec: number;
      flushStats: { min: number; max: number; avg: number; p50: number; p95: number; p99: number };
      failures: number;
      failureRate: number;
      pollingOverheadEstimate: string;
    }> = [];

    console.log(`\n5.3 Lock contention scaling (${opsPerWorker} ops/worker, ${dims}d, lockTimeout=${lockAcquireTimeout}ms):`);
    console.log('  Procs | Total(ms) | Ops/s   | Avg(ms) | P50(ms) | P95(ms) | P99(ms) |  Max(ms) | Fails');
    console.log('  ------|-----------|---------|---------|---------|---------|---------|----------|------');

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
              lockAcquireTimeout,
            }),
          ),
        );

        // Track per-operation flush durations and failures
        const allFlushDurations: number[] = [];
        let failures = 0;

        const { durationMs } = await measure(async () => {
          await Promise.all(
            procs.map(async (proc, idx) => {
              for (let op = 0; op < opsPerWorker; op++) {
                await sendCommand(proc, {
                  type: 'add',
                  id: `p${idx}-op${op}`,
                  embedding: [idx, op, idx + op],
                });
                const flushStart = performance.now();
                const res = await sendCommand(proc, { type: 'flush' });
                const flushDuration = performance.now() - flushStart;
                allFlushDurations.push(flushDuration);
                if (!res.success) {
                  failures++;
                }
              }
            }),
          );
        });

        const totalOps = N * opsPerWorker;
        const throughput = (totalOps / durationMs) * 1000;
        const stats = computeStats(allFlushDurations);
        const failureRate = failures / totalOps;

        // Estimate polling overhead: theoretical serial work vs actual total
        // Each op holds the lock briefly (~1-5ms), the rest is polling waste
        const estimatedLockHoldMs = 3; // approximate
        const theoreticalSerialMs = totalOps * estimatedLockHoldMs;
        const overheadRatio = durationMs / theoreticalSerialMs;

        report.push({
          processes: N,
          opsPerWorker,
          totalOps,
          totalMs: Math.round(durationMs),
          throughputOpsPerSec: Math.round(throughput * 10) / 10,
          flushStats: {
            min: Math.round(stats.min * 100) / 100,
            max: Math.round(stats.max * 100) / 100,
            avg: Math.round(stats.avg * 100) / 100,
            p50: Math.round(stats.p50 * 100) / 100,
            p95: Math.round(stats.p95 * 100) / 100,
            p99: Math.round(stats.p99 * 100) / 100,
          },
          failures,
          failureRate: Math.round(failureRate * 10000) / 10000,
          pollingOverheadEstimate: `${overheadRatio.toFixed(1)}x (actual ${Math.round(durationMs)}ms vs theoretical ${theoreticalSerialMs}ms serial)`,
        });

        console.log(
          `  ${String(N).padStart(5)} | ${durationMs.toFixed(0).padStart(9)} | ${throughput.toFixed(1).padStart(7)} | ${stats.avg.toFixed(1).padStart(7)} | ${stats.p50.toFixed(1).padStart(7)} | ${stats.p95.toFixed(1).padStart(7)} | ${stats.p99.toFixed(1).padStart(7)} | ${stats.max.toFixed(0).padStart(8)} | ${String(failures).padStart(5)}`,
        );

        // Cleanup workers for this iteration
        for (const proc of procs) {
          await sendCommand(proc, { type: 'close' }).catch(() => {});
          proc.kill('SIGTERM');
        }
        for (const proc of procs) {
          const idx = workers.indexOf(proc);
          if (idx >= 0) workers.splice(idx, 1);
        }
      } finally {
        await rm(testDir, { recursive: true, force: true });
      }
    }

    // Write structured results to JSON
    const { mkdir } = await import('node:fs/promises');
    await mkdir(RESULTS_DIR, { recursive: true });
    await writeFile(
      join(RESULTS_DIR, 'contention-scaling.json'),
      JSON.stringify({
        test: '5.3',
        description: 'Lock contention with N concurrent processes',
        timestamp: new Date().toISOString(),
        config: { dims, opsPerWorker, lockAcquireTimeout, lockRetryInterval: 200 },
        tiers: report,
      }, null, 2),
    );
    console.log(`\n  Results written to tests/storage/__stress__/results/contention-scaling.json`);
  }, 300_000);

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

  it('5.6 contention matrix -- vector size x ops/worker x process count', async () => {
    const lockAcquireTimeout = 30_000;
    const processCounts = [2, 8, 32];

    const scenarios = [
      { dims: 384, opsPerWorker: 50, label: '384d x 50ops' },
      { dims: 768, opsPerWorker: 50, label: '768d x 50ops' },
      { dims: 3, opsPerWorker: 200, label: '3d x 200ops' },
    ];

    const report: Array<{
      scenario: string;
      dims: number;
      opsPerWorker: number;
      processes: number;
      totalOps: number;
      totalMs: number;
      throughputOpsPerSec: number;
      flushStats: { min: number; max: number; avg: number; p50: number; p95: number; p99: number };
      failures: number;
      failureRate: number;
    }> = [];

    for (const scenario of scenarios) {
      console.log(`\n5.6 Contention matrix [${scenario.label}] (lockTimeout=${lockAcquireTimeout}ms):`);
      console.log('  Procs | Total(ms) | Ops/s   | Avg(ms) | P50(ms) | P95(ms) | P99(ms) |  Max(ms) | Fails');
      console.log('  ------|-----------|---------|---------|---------|---------|---------|----------|------');

      for (const N of processCounts) {
        const testDir = await mkdtemp(join(tmpdir(), `trovec-matrix-${scenario.dims}d-${N}p-`));
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
                collectionId: 'matrix',
                dimensions: scenario.dims,
                wal: true,
                lockAcquireTimeout,
              }),
            ),
          );

          const allFlushDurations: number[] = [];
          let failures = 0;

          // Pre-generate embeddings to avoid measuring random number generation
          const embeddings: number[][] = [];
          for (let idx = 0; idx < N; idx++) {
            for (let op = 0; op < scenario.opsPerWorker; op++) {
              embeddings.push(randomEmbedding(scenario.dims));
            }
          }

          const { durationMs } = await measure(async () => {
            await Promise.all(
              procs.map(async (proc, idx) => {
                for (let op = 0; op < scenario.opsPerWorker; op++) {
                  const embedding = embeddings[idx * scenario.opsPerWorker + op];
                  await sendCommand(proc, {
                    type: 'add',
                    id: `p${idx}-op${op}`,
                    embedding,
                  });
                  const flushStart = performance.now();
                  const res = await sendCommand(proc, { type: 'flush' });
                  const flushDuration = performance.now() - flushStart;
                  allFlushDurations.push(flushDuration);
                  if (!res.success) {
                    failures++;
                  }
                }
              }),
            );
          });

          const totalOps = N * scenario.opsPerWorker;
          const throughput = (totalOps / durationMs) * 1000;
          const stats = computeStats(allFlushDurations);
          const failureRate = failures / totalOps;

          report.push({
            scenario: scenario.label,
            dims: scenario.dims,
            opsPerWorker: scenario.opsPerWorker,
            processes: N,
            totalOps,
            totalMs: Math.round(durationMs),
            throughputOpsPerSec: Math.round(throughput * 10) / 10,
            flushStats: {
              min: Math.round(stats.min * 100) / 100,
              max: Math.round(stats.max * 100) / 100,
              avg: Math.round(stats.avg * 100) / 100,
              p50: Math.round(stats.p50 * 100) / 100,
              p95: Math.round(stats.p95 * 100) / 100,
              p99: Math.round(stats.p99 * 100) / 100,
            },
            failures,
            failureRate: Math.round(failureRate * 10000) / 10000,
          });

          console.log(
            `  ${String(N).padStart(5)} | ${durationMs.toFixed(0).padStart(9)} | ${throughput.toFixed(1).padStart(7)} | ${stats.avg.toFixed(1).padStart(7)} | ${stats.p50.toFixed(1).padStart(7)} | ${stats.p95.toFixed(1).padStart(7)} | ${stats.p99.toFixed(1).padStart(7)} | ${stats.max.toFixed(0).padStart(8)} | ${String(failures).padStart(5)}`,
          );

          // Cleanup workers for this iteration
          for (const proc of procs) {
            await sendCommand(proc, { type: 'close' }).catch(() => {});
            proc.kill('SIGTERM');
          }
          for (const proc of procs) {
            const wIdx = workers.indexOf(proc);
            if (wIdx >= 0) workers.splice(wIdx, 1);
          }
        } finally {
          await rm(testDir, { recursive: true, force: true });
        }
      }
    }

    // Write structured results to JSON
    const { mkdir } = await import('node:fs/promises');
    await mkdir(RESULTS_DIR, { recursive: true });
    await writeFile(
      join(RESULTS_DIR, 'contention-matrix.json'),
      JSON.stringify({
        test: '5.6',
        description: 'Contention matrix -- vector size x ops/worker x process count',
        timestamp: new Date().toISOString(),
        config: { lockAcquireTimeout, lockRetryInterval: 200, processCounts, scenarios: scenarios.map((s) => s.label) },
        results: report,
      }, null, 2),
    );
    console.log(`\n  Results written to tests/storage/__stress__/results/contention-matrix.json`);
  }, 600_000);

  it('5.7 data size impact on operations (128d, 1K to 1M)', async () => {
    const dims = 128;
    const walOpsPerTier = 100;
    const tiers = [1_000, 10_000, 100_000, 500_000, 1_000_000];

    const report: Array<{
      entries: number;
      populate: { addMs: number; flushMs: number; fileMB: number };
      init: { ms: number; heapUsedMB: number; rssMB: number };
      walAppend: { totalMs: number; avgFlushMs: number; opsPerSec: number };
      readWithWal: { ms: number; walEntries: number };
      checkpoint: { ms: number; fileMB: number };
      readAfterCheckpoint: { ms: number };
      memory: { heapUsedMB: number; heapTotalMB: number; rssMB: number; externalMB: number };
    }> = [];

    console.log(`\n5.7 Data size impact on operations (${dims}d, F32):`);
    console.log('  Entries   | Pop(ms) | Flush(ms) | File(MB) | Init(ms) | Heap(MB) | WAL avg(ms) | Read+WAL(ms) | Chkpt(ms) | Read(ms)');
    console.log('  ----------|---------|-----------|----------|----------|----------|-------------|--------------|-----------|----------');

    for (const count of tiers) {
      const testDir = await mkdtemp(join(tmpdir(), `trovec-datasize-${count}-`));
      try {
        // Force GC if available, to get cleaner memory baselines
        if (global.gc) global.gc();

        // --- 1. Populate + full write ---
        const driver = createConcurrentFileDriver({ directory: testDir, wal: true });
        const instance = await create({
          dimensions: dims,
          storageDriver: driver,
          collectionId: 'datasize',
          autoFlush: false,
        });
        const inst = instance as unknown as TrovecInstance;

        const { durationMs: addMs } = await measure(async () => {
          // Add in batches of 10K to avoid excessive memory pressure
          const batchSize = Math.min(10_000, count);
          for (let offset = 0; offset < count; offset += batchSize) {
            const thisBatch = Math.min(batchSize, count - offset);
            const entries = Array.from({ length: thisBatch }, (_, i) => ({
              id: `e-${offset + i}`,
              embedding: randomEmbedding(dims),
            }));
            addMany(inst, entries);
          }
        });

        const { durationMs: flushMs } = await measure(async () => {
          await flush(inst);
        });

        const fileStat = await stat(join(testDir, 'datasize.trovec'));
        const fileMB = fileStat.size / 1024 / 1024;

        // Close the populating instance to free memory
        await close(inst);

        // --- 2. Init benchmark (fresh create() loading from disk) ---
        if (global.gc) global.gc();
        const heapBeforeInit = process.memoryUsage().heapUsed;

        const { durationMs: initMs, result: initInstance } = await measure(async () => {
          const d = createConcurrentFileDriver({ directory: testDir, wal: true });
          return await create({
            dimensions: dims,
            storageDriver: d,
            collectionId: 'datasize',
            autoFlush: false,
          });
        });

        const heapAfterInit = process.memoryUsage();
        const initHeapDelta = (heapAfterInit.heapUsed - heapBeforeInit) / 1024 / 1024;
        const initRss = heapAfterInit.rss / 1024 / 1024;

        expect((initInstance as unknown as TrovecInstance).entries.size).toBe(count);
        await close(initInstance as unknown as TrovecInstance);

        // --- 3. WAL append benchmark (single-process, 100 ops on top of base) ---
        const walDriver = createConcurrentFileDriver({ directory: testDir, wal: true });
        const walInstance = await create({
          dimensions: dims,
          storageDriver: walDriver,
          collectionId: 'datasize',
          autoFlush: false,
        });
        const walInst = walInstance as unknown as TrovecInstance;

        const walEmbeddings = Array.from({ length: walOpsPerTier }, () => randomEmbedding(dims));

        const { durationMs: walTotalMs } = await measure(async () => {
          for (let i = 0; i < walOpsPerTier; i++) {
            add(walInst, {
              id: `wal-${i}`,
              embedding: walEmbeddings[i],
            });
            await flush(walInst);
          }
        });

        const walAvgFlushMs = walTotalMs / walOpsPerTier;
        const walOpsPerSec = (walOpsPerTier / walTotalMs) * 1000;

        // --- 4. Read with WAL entries ---
        const { durationMs: readWithWalMs } = await measure(async () => {
          const d = createConcurrentFileDriver({ directory: testDir, wal: true });
          const i2 = await create({
            dimensions: dims,
            storageDriver: d,
            collectionId: 'datasize',
            autoFlush: false,
          });
          expect((i2 as unknown as TrovecInstance).entries.size).toBe(count + walOpsPerTier);
          await close(i2 as unknown as TrovecInstance);
        });

        // --- 5. Checkpoint ---
        const { durationMs: checkpointMs } = await measure(async () => {
          const fullBuffer = serialize(walInst);
          await walDriver.checkpoint('datasize', fullBuffer);
        });

        await close(walInst);

        const checkpointFileStat = await stat(join(testDir, 'datasize.trovec'));
        const checkpointFileMB = checkpointFileStat.size / 1024 / 1024;

        // --- 6. Read after checkpoint (clean base, no WAL) ---
        const { durationMs: readAfterCheckpointMs } = await measure(async () => {
          const d = createConcurrentFileDriver({ directory: testDir, wal: true });
          const i2 = await create({
            dimensions: dims,
            storageDriver: d,
            collectionId: 'datasize',
            autoFlush: false,
          });
          expect((i2 as unknown as TrovecInstance).entries.size).toBe(count + walOpsPerTier);
          await close(i2 as unknown as TrovecInstance);
        });

        // --- Memory snapshot ---
        if (global.gc) global.gc();
        const mem = process.memoryUsage();

        report.push({
          entries: count,
          populate: { addMs: Math.round(addMs), flushMs: Math.round(flushMs), fileMB: Math.round(fileMB * 100) / 100 },
          init: { ms: Math.round(initMs), heapUsedMB: Math.round(initHeapDelta * 10) / 10, rssMB: Math.round(initRss) },
          walAppend: { totalMs: Math.round(walTotalMs), avgFlushMs: Math.round(walAvgFlushMs * 100) / 100, opsPerSec: Math.round(walOpsPerSec) },
          readWithWal: { ms: Math.round(readWithWalMs), walEntries: walOpsPerTier },
          checkpoint: { ms: Math.round(checkpointMs), fileMB: Math.round(checkpointFileMB * 100) / 100 },
          readAfterCheckpoint: { ms: Math.round(readAfterCheckpointMs) },
          memory: {
            heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
            heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
            rssMB: Math.round(mem.rss / 1024 / 1024),
            externalMB: Math.round(mem.external / 1024 / 1024),
          },
        });

        console.log(
          `  ${String(count).padStart(9)} | ${String(Math.round(addMs)).padStart(7)} | ${String(Math.round(flushMs)).padStart(9)} | ${fileMB.toFixed(2).padStart(8)} | ${String(Math.round(initMs)).padStart(8)} | ${initHeapDelta.toFixed(0).padStart(8)} | ${walAvgFlushMs.toFixed(2).padStart(11)} | ${String(Math.round(readWithWalMs)).padStart(12)} | ${String(Math.round(checkpointMs)).padStart(9)} | ${String(Math.round(readAfterCheckpointMs)).padStart(8)}`,
        );

        // Break early if init is too slow (memory pressure)
        if (initMs > 60_000) {
          console.log(`  *** LIMIT REACHED at ${count} entries (init > 60s) ***`);
          break;
        }
      } finally {
        await rm(testDir, { recursive: true, force: true });
      }
    }

    // Write structured results to JSON
    const { mkdir } = await import('node:fs/promises');
    await mkdir(RESULTS_DIR, { recursive: true });
    await writeFile(
      join(RESULTS_DIR, 'datasize-operations.json'),
      JSON.stringify({
        test: '5.7',
        description: 'Data size impact on init, WAL append, read, checkpoint, and memory',
        timestamp: new Date().toISOString(),
        config: { dims, walOpsPerTier, quantization: 'F32' },
        tiers: report,
      }, null, 2),
    );
    console.log(`\n  Results written to tests/storage/__stress__/results/datasize-operations.json`);
  }, 600_000);

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
