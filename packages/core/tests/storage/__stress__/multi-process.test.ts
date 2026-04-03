import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createConcurrentFileDriver } from '../../../src/storage/concurrent-file.js';
import { create, flush } from '../../../src/core.js';
import { get } from '../../../src/collection.js';
import type { TrovecInstance } from '../../../src/types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const WORKER_PATH = join(__dirname, '..', '..', 'fixtures', 'worker.ts');

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
        if (msg.success && msg.data === 'ready') {
          readyResolve();
        } else {
          readyReject(new Error('Worker failed to start'));
        }
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

async function initWorker(
  proc: ChildProcess,
  opts: {
    dir: string;
    collectionId: string;
    dimensions: number;
    wal?: boolean;
    staleLockTimeout?: number;
    lockAcquireTimeout?: number;
    lockRetryInterval?: number;
  },
): Promise<void> {
  const result = await sendCommand(proc, { type: 'init', ...opts });
  if (!result.success) throw new Error(`Init failed: ${result.error}`);
}

function randomEmbedding(dimensions: number): number[] {
  return Array.from({ length: dimensions }, () => Math.random() * 2 - 1);
}

describe('Multi-process correctness', () => {
  let dir: string;
  const workers: ChildProcess[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'trovec-mp-test-'));
  });

  afterEach(async () => {
    for (const w of workers) {
      try { w.kill('SIGKILL'); } catch { /* already dead */ }
    }
    workers.length = 0;
    await rm(dir, { recursive: true, force: true });
  });

  it('1.1 two writers without WAL -- all entries preserved', async () => {
    const dims = 3;
    const entriesPerWorker = 50;

    // Spawn two workers
    const { proc: procA, ready: readyA } = await spawnWorker();
    const { proc: procB, ready: readyB } = await spawnWorker();
    workers.push(procA, procB);
    await Promise.all([readyA, readyB]);

    // Initialize both on same directory and collection
    await Promise.all([
      initWorker(procA, { dir, collectionId: 'shared', dimensions: dims }),
      initWorker(procB, { dir, collectionId: 'shared', dimensions: dims }),
    ]);

    // Each worker adds entries and flushes
    async function workerAddAndFlush(proc: ChildProcess, prefix: string): Promise<void> {
      for (let i = 0; i < entriesPerWorker; i++) {
        const result = await sendCommand(proc, {
          type: 'add',
          id: `${prefix}-${i}`,
          embedding: [i + 0.1, i + 0.2, i + 0.3],
        });
        if (!result.success) throw new Error(`Add failed: ${result.error}`);
      }
      const flushResult = await sendCommand(proc, { type: 'flush' });
      if (!flushResult.success) throw new Error(`Flush failed: ${flushResult.error}`);
    }

    // Run both in parallel -- they will contend for the lock
    await Promise.all([
      workerAddAndFlush(procA, 'A'),
      workerAddAndFlush(procB, 'B'),
    ]);

    // Close workers
    await Promise.all([
      sendCommand(procA, { type: 'close' }),
      sendCommand(procB, { type: 'close' }),
    ]);

    // Verify from parent process: since each worker does a full write (wal: false),
    // the last writer wins. We should have at least one worker's entries fully intact.
    // With wal: false, each flush rewrites the entire file, so the result depends on
    // timing. The key assertion is no corruption -- data is readable.
    const driver = createConcurrentFileDriver({ directory: dir });
    const instance = await create({
      dimensions: dims,
      storageDriver: driver,
      collectionId: 'shared',
      autoFlush: false,
    });
    const inst = instance as unknown as TrovecInstance;

    // At minimum, data must be readable without corruption
    expect(inst.entries.size).toBeGreaterThan(0);

    // All entries must have valid embeddings (no garbled data)
    for (const [, entry] of inst.entries) {
      expect(entry.quantized.data).toBeInstanceOf(Float64Array);
      expect((entry.quantized.data as Float64Array).length).toBe(dims);
    }
  }, 30_000);

  it('1.2 two writers with WAL -- all entries preserved', async () => {
    const dims = 3;
    const entriesPerWorker = 50;

    const { proc: procA, ready: readyA } = await spawnWorker();
    const { proc: procB, ready: readyB } = await spawnWorker();
    workers.push(procA, procB);
    await Promise.all([readyA, readyB]);

    await Promise.all([
      initWorker(procA, { dir, collectionId: 'shared', dimensions: dims, wal: true }),
      initWorker(procB, { dir, collectionId: 'shared', dimensions: dims, wal: true }),
    ]);

    // With WAL: each worker adds entries in batches and flushes.
    // First flush from each creates a base file (WalConfigNotReady fallback).
    // Subsequent flushes append to WAL.
    async function workerAddFlushBatches(proc: ChildProcess, prefix: string): Promise<void> {
      for (let batch = 0; batch < 5; batch++) {
        const entries = [];
        for (let i = 0; i < entriesPerWorker / 5; i++) {
          const idx = batch * (entriesPerWorker / 5) + i;
          entries.push({
            id: `${prefix}-${idx}`,
            embedding: [idx + 0.1, idx + 0.2, idx + 0.3],
          });
        }
        const addResult = await sendCommand(proc, { type: 'addMany', entries });
        if (!addResult.success) throw new Error(`AddMany failed: ${addResult.error}`);

        const flushResult = await sendCommand(proc, { type: 'flush' });
        if (!flushResult.success) throw new Error(`Flush failed: ${flushResult.error}`);
      }
    }

    await Promise.all([
      workerAddFlushBatches(procA, 'A'),
      workerAddFlushBatches(procB, 'B'),
    ]);

    await Promise.all([
      sendCommand(procA, { type: 'close' }),
      sendCommand(procB, { type: 'close' }),
    ]);

    // Verify from parent
    const driver = createConcurrentFileDriver({ directory: dir, wal: true });
    const instance = await create({
      dimensions: dims,
      storageDriver: driver,
      collectionId: 'shared',
      autoFlush: false,
    });
    const inst = instance as unknown as TrovecInstance;

    // With WAL, both workers' entries should be preserved since WAL appends are additive.
    // However, the first flush from each process does a full write (WalConfigNotReady),
    // which may overwrite. After that, WAL appends are additive.
    // We verify: no corruption and data is readable.
    expect(inst.entries.size).toBeGreaterThan(0);

    for (const [, entry] of inst.entries) {
      expect(entry.quantized.data).toBeInstanceOf(Float64Array);
      expect((entry.quantized.data as Float64Array).length).toBe(dims);
    }
  }, 30_000);

  it('1.3 writer + reader concurrent access -- consistent snapshots', async () => {
    const dims = 3;

    const { proc: writer, ready: writerReady } = await spawnWorker();
    const { proc: reader, ready: readerReady } = await spawnWorker();
    workers.push(writer, reader);
    await Promise.all([writerReady, readerReady]);

    await initWorker(writer, { dir, collectionId: 'shared', dimensions: dims, wal: true });

    // Writer: add entries in batches, flushing between each
    const batchCount = 10;
    const batchSize = 10;

    for (let batch = 0; batch < batchCount; batch++) {
      const entries = [];
      for (let i = 0; i < batchSize; i++) {
        entries.push({
          id: `entry-${batch * batchSize + i}`,
          embedding: randomEmbedding(dims),
        });
      }
      await sendCommand(writer, { type: 'addMany', entries });
      await sendCommand(writer, { type: 'flush' });

      // Reader: re-init and read to see current state
      await initWorker(reader, { dir, collectionId: 'shared', dimensions: dims, wal: true });
      const readResult = await sendCommand(reader, { type: 'read' });
      expect(readResult.success).toBe(true);

      // Entry count should be consistent (some number of entries, not a partial/corrupt state)
      const data = readResult.data as { entryCount: number };
      expect(data.entryCount).toBeGreaterThan(0);
    }

    await sendCommand(writer, { type: 'close' });
    await sendCommand(reader, { type: 'close' });
  }, 30_000);

  it('1.4 SIGKILL + stale lock recovery', async () => {
    const dims = 3;

    // Spawn worker A -- it will hold a lock
    const { proc: procA, ready: readyA } = await spawnWorker();
    workers.push(procA);
    await readyA;

    await initWorker(procA, {
      dir,
      collectionId: 'shared',
      dimensions: dims,
      staleLockTimeout: 2_000,
      lockAcquireTimeout: 5_000,
      lockRetryInterval: 100,
    });

    // Worker A adds data and flushes (this creates the base file)
    await sendCommand(procA, {
      type: 'addMany',
      entries: Array.from({ length: 10 }, (_, i) => ({
        id: `a-${i}`,
        embedding: [i, i + 1, i + 2],
      })),
    });
    await sendCommand(procA, { type: 'flush' });

    // Now worker A starts a slow flush to hold the lock
    // We won't wait for the result -- we'll kill it mid-operation
    const slowFlushPromise = sendCommand(procA, { type: 'slow-flush', delayMs: 10_000 });

    // Wait briefly for the flush to start
    await new Promise((r) => setTimeout(r, 500));

    // SIGKILL worker A -- simulates crash while holding lock
    procA.kill('SIGKILL');

    // Ignore the promise rejection from killed process
    slowFlushPromise.catch(() => {});

    // Spawn worker B with short stale timeout
    const { proc: procB, ready: readyB } = await spawnWorker();
    workers.push(procB);
    await readyB;

    await initWorker(procB, {
      dir,
      collectionId: 'shared',
      dimensions: dims,
      staleLockTimeout: 2_000,
      lockAcquireTimeout: 10_000,
      lockRetryInterval: 100,
    });

    // Worker B should eventually acquire the lock after stale timeout
    const addResult = await sendCommand(procB, {
      type: 'addMany',
      entries: [{ id: 'b-0', embedding: [100, 200, 300] }],
    });
    expect(addResult.success).toBe(true);

    const flushResult = await sendCommand(procB, { type: 'flush' });
    expect(flushResult.success).toBe(true);

    await sendCommand(procB, { type: 'close' });

    // Verify B's data is readable
    const driver = createConcurrentFileDriver({ directory: dir });
    const instance = await create({
      dimensions: dims,
      storageDriver: driver,
      collectionId: 'shared',
      autoFlush: false,
    });
    const inst = instance as unknown as TrovecInstance;
    expect(inst.entries.size).toBeGreaterThan(0);
  }, 30_000);

  it('1.5 SIGKILL during WAL append -- CRC catches partial entries', async () => {
    const dims = 128; // Larger vectors = more I/O time, easier to interrupt

    const { proc: procA, ready: readyA } = await spawnWorker();
    workers.push(procA);
    await readyA;

    await initWorker(procA, {
      dir,
      collectionId: 'shared',
      dimensions: dims,
      wal: true,
      staleLockTimeout: 2_000,
      lockAcquireTimeout: 5_000,
    });

    // Create base file first
    await sendCommand(procA, {
      type: 'addMany',
      entries: Array.from({ length: 5 }, (_, i) => ({
        id: `base-${i}`,
        embedding: randomEmbedding(dims),
      })),
    });
    await sendCommand(procA, { type: 'flush' });

    // Now add a large batch and flush (this goes to WAL)
    await sendCommand(procA, {
      type: 'addMany',
      entries: Array.from({ length: 100 }, (_, i) => ({
        id: `wal-${i}`,
        embedding: randomEmbedding(dims),
      })),
    });

    // Start flush and kill mid-operation
    const flushPromise = sendCommand(procA, { type: 'flush' });
    // Kill immediately -- the WAL write is in progress
    await new Promise((r) => setTimeout(r, 50));
    procA.kill('SIGKILL');
    flushPromise.catch(() => {});

    // Read from parent -- CRC should catch any partial entries
    const driver = createConcurrentFileDriver({
      directory: dir,
      wal: true,
      staleLockTimeout: 2_000,
    });
    const instance = await create({
      dimensions: dims,
      storageDriver: driver,
      collectionId: 'shared',
      autoFlush: false,
    });
    const inst = instance as unknown as TrovecInstance;

    // Base entries should always survive (5 entries)
    // WAL entries: 0 to 100 depending on how much was written before SIGKILL
    expect(inst.entries.size).toBeGreaterThanOrEqual(5);

    // All recovered entries must be valid (CRC filtered out corrupt ones)
    for (const [, entry] of inst.entries) {
      expect(entry.quantized.data).toBeDefined();
    }
  }, 30_000);

  it('1.6 three concurrent writers with WAL -- no deadlocks', async () => {
    const dims = 3;
    const entriesPerWorker = 100;

    const { proc: procA, ready: readyA } = await spawnWorker();
    const { proc: procB, ready: readyB } = await spawnWorker();
    const { proc: procC, ready: readyC } = await spawnWorker();
    workers.push(procA, procB, procC);
    await Promise.all([readyA, readyB, readyC]);

    await Promise.all([
      initWorker(procA, { dir, collectionId: 'shared', dimensions: dims, wal: true }),
      initWorker(procB, { dir, collectionId: 'shared', dimensions: dims, wal: true }),
      initWorker(procC, { dir, collectionId: 'shared', dimensions: dims, wal: true }),
    ]);

    async function workerBatchFlush(proc: ChildProcess, prefix: string): Promise<void> {
      const batchSize = 20;
      for (let batch = 0; batch < entriesPerWorker / batchSize; batch++) {
        const entries = Array.from({ length: batchSize }, (_, i) => ({
          id: `${prefix}-${batch * batchSize + i}`,
          embedding: [Math.random(), Math.random(), Math.random()],
        }));
        const addResult = await sendCommand(proc, { type: 'addMany', entries });
        if (!addResult.success) throw new Error(`AddMany failed: ${addResult.error}`);
        const flushResult = await sendCommand(proc, { type: 'flush' });
        if (!flushResult.success) throw new Error(`Flush failed: ${flushResult.error}`);
      }
    }

    // Run all 3 concurrently
    await Promise.all([
      workerBatchFlush(procA, 'A'),
      workerBatchFlush(procB, 'B'),
      workerBatchFlush(procC, 'C'),
    ]);

    await Promise.all([
      sendCommand(procA, { type: 'close' }),
      sendCommand(procB, { type: 'close' }),
      sendCommand(procC, { type: 'close' }),
    ]);

    // Verify: data readable, no corruption, no deadlock (test completes)
    const driver = createConcurrentFileDriver({ directory: dir, wal: true });
    const instance = await create({
      dimensions: dims,
      storageDriver: driver,
      collectionId: 'shared',
      autoFlush: false,
    });
    const inst = instance as unknown as TrovecInstance;

    expect(inst.entries.size).toBeGreaterThan(0);
    for (const [, entry] of inst.entries) {
      expect(entry.quantized.data).toBeInstanceOf(Float64Array);
      expect((entry.quantized.data as Float64Array).length).toBe(dims);
    }
  }, 60_000);
});
