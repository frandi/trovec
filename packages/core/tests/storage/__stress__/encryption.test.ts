import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createConcurrentFileDriver } from '../../../src/storage/concurrent-file.js';
import { createFileDriver } from '../../../src/storage/file.js';
import { withEncryption } from '../../../src/storage/encryption.js';
import { create, flush, close } from '../../../src/core.js';
import { add, addMany, get } from '../../../src/collection.js';
import { serialize } from '../../../src/serialization.js';
import type { TrovecInstance } from '../../../src/types.js';

const RESULTS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'results');

function randomEmbedding(dimensions: number): number[] {
  return Array.from({ length: dimensions }, () => Math.random() * 2 - 1);
}

async function measure<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, durationMs: performance.now() - start };
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computeStats(values: number[]) {
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

describe('Encryption stress & benchmarks', () => {
  let dir: string;
  const workers: ChildProcess[] = [];
  const TEST_KEY = randomBytes(32);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'trovec-enc-stress-'));
  });

  afterEach(async () => {
    for (const w of workers) {
      try { w.kill('SIGKILL'); } catch { /* already dead */ }
    }
    workers.length = 0;
    await rm(dir, { recursive: true, force: true });
  });

  it('6.1 encryption overhead: flush + read across dataset sizes', async () => {
    const dims = 128;
    const tiers = [1_000, 5_000, 10_000, 50_000, 100_000];

    console.log('\n6.1 Encryption overhead (flush + read, 128d):');
    console.log('  Entries |  Flush(ms)    |  Read(ms)     |  File size       | Overhead');
    console.log('         | plain   enc   | plain   enc   | plain    enc     | (flush / read)');
    console.log('  -------|---------------|---------------|------------------|---------------');

    const results: Array<Record<string, unknown>> = [];

    for (const entryCount of tiers) {
      const entries = Array.from({ length: entryCount }, (_, i) => ({
        id: `e-${i}`,
        embedding: randomEmbedding(dims),
      }));

      // --- Plain (no encryption) ---
      const plainDir = await mkdtemp(join(tmpdir(), 'trovec-enc-plain-'));
      try {
        const plainDriver = createConcurrentFileDriver({ directory: plainDir });
        const plainInst = await create({
          dimensions: dims, storageDriver: plainDriver,
          collectionId: 'bench', autoFlush: false,
        });
        addMany(plainInst as unknown as TrovecInstance, entries);

        const { durationMs: plainFlush } = await measure(async () => {
          await flush(plainInst as unknown as TrovecInstance);
        });
        await close(plainInst as unknown as TrovecInstance);

        const plainFile = await stat(join(plainDir, 'bench.trovec'));

        const { durationMs: plainRead } = await measure(async () => {
          const d = createConcurrentFileDriver({ directory: plainDir });
          const i = await create({ dimensions: dims, storageDriver: d, collectionId: 'bench', autoFlush: false });
          expect((i as unknown as TrovecInstance).entries.size).toBe(entryCount);
        });

        // --- Encrypted ---
        const encDir = await mkdtemp(join(tmpdir(), 'trovec-enc-aes-'));

        const encDriver = createConcurrentFileDriver({ directory: encDir, encryption: { key: TEST_KEY } });
        const encInst = await create({
          dimensions: dims, storageDriver: encDriver,
          collectionId: 'bench', autoFlush: false,
        });
        addMany(encInst as unknown as TrovecInstance, entries);

        const { durationMs: encFlush } = await measure(async () => {
          await flush(encInst as unknown as TrovecInstance);
        });
        await close(encInst as unknown as TrovecInstance);

        const encFile = await stat(join(encDir, 'bench.trovec'));

        const { durationMs: encRead } = await measure(async () => {
          const d = createConcurrentFileDriver({ directory: encDir, encryption: { key: TEST_KEY } });
          const i = await create({ dimensions: dims, storageDriver: d, collectionId: 'bench', autoFlush: false });
          expect((i as unknown as TrovecInstance).entries.size).toBe(entryCount);
        });

        const flushOverhead = ((encFlush / plainFlush - 1) * 100).toFixed(1);
        const readOverhead = ((encRead / plainRead - 1) * 100).toFixed(1);
        const sizeDiff = encFile.size - plainFile.size;

        console.log(
          `  ${String(entryCount).padStart(6)} ` +
          `| ${plainFlush.toFixed(0).padStart(5)}  ${encFlush.toFixed(0).padStart(5)} ` +
          `| ${plainRead.toFixed(0).padStart(5)}  ${encRead.toFixed(0).padStart(5)} ` +
          `| ${(plainFile.size / 1024).toFixed(0).padStart(6)}KB ${(encFile.size / 1024).toFixed(0).padStart(6)}KB ` +
          `| +${flushOverhead}% / +${readOverhead}%`,
        );

        results.push({
          entries: entryCount,
          plain: { flushMs: +plainFlush.toFixed(1), readMs: +plainRead.toFixed(1), fileBytes: plainFile.size },
          encrypted: { flushMs: +encFlush.toFixed(1), readMs: +encRead.toFixed(1), fileBytes: encFile.size },
          overhead: { flushPct: +flushOverhead, readPct: +readOverhead, sizeBytes: sizeDiff },
        });

        await rm(encDir, { recursive: true, force: true });
      } finally {
        await rm(plainDir, { recursive: true, force: true });
      }
    }

    await writeFile(
      join(RESULTS_DIR, 'encryption-overhead.json'),
      JSON.stringify({
        test: '6.1',
        description: 'Encryption overhead: flush + read across dataset sizes',
        timestamp: new Date().toISOString(),
        config: { dims, algorithm: 'AES-256-GCM', keyMode: 'raw' },
        tiers: results,
      }, null, 2),
    );
    console.log('\n  Results written to tests/storage/__stress__/results/encryption-overhead.json');
  }, 300_000);

  it('6.2 encryption overhead: WAL append throughput', async () => {
    const dims = 128;
    const totalAppends = 500;

    console.log('\n6.2 WAL append throughput with encryption (128d):');

    // --- Plain WAL ---
    const plainDir = await mkdtemp(join(tmpdir(), 'trovec-wal-plain-'));
    const plainDriver = createConcurrentFileDriver({ directory: plainDir, wal: true });
    const plainInst = await create({
      dimensions: dims, storageDriver: plainDriver,
      collectionId: 'wal', autoFlush: false,
    });
    // Seed to learn config
    add(plainInst as unknown as TrovecInstance, { id: 'seed', embedding: randomEmbedding(dims) });
    await flush(plainInst as unknown as TrovecInstance);

    const plainDurations: number[] = [];
    for (let i = 0; i < totalAppends; i++) {
      const start = performance.now();
      add(plainInst as unknown as TrovecInstance, { id: `wal-${i}`, embedding: randomEmbedding(dims) });
      await flush(plainInst as unknown as TrovecInstance);
      plainDurations.push(performance.now() - start);
    }
    await close(plainInst as unknown as TrovecInstance);

    // --- Encrypted WAL ---
    const encDir = await mkdtemp(join(tmpdir(), 'trovec-wal-enc-'));
    const encDriver = createConcurrentFileDriver({ directory: encDir, wal: true, encryption: { key: TEST_KEY } });
    const encInst = await create({
      dimensions: dims, storageDriver: encDriver,
      collectionId: 'wal', autoFlush: false,
    });
    add(encInst as unknown as TrovecInstance, { id: 'seed', embedding: randomEmbedding(dims) });
    await flush(encInst as unknown as TrovecInstance);

    const encDurations: number[] = [];
    for (let i = 0; i < totalAppends; i++) {
      const start = performance.now();
      add(encInst as unknown as TrovecInstance, { id: `wal-${i}`, embedding: randomEmbedding(dims) });
      await flush(encInst as unknown as TrovecInstance);
      encDurations.push(performance.now() - start);
    }
    await close(encInst as unknown as TrovecInstance);

    const plainStats = computeStats(plainDurations);
    const encStats = computeStats(encDurations);
    const plainOpsPerSec = (totalAppends / plainDurations.reduce((s, v) => s + v, 0)) * 1000;
    const encOpsPerSec = (totalAppends / encDurations.reduce((s, v) => s + v, 0)) * 1000;

    console.log(`  ${totalAppends} WAL appends each:`);
    console.log('          |  avg(ms)  |  p50(ms)  |  p95(ms)  |  p99(ms)  |  ops/sec');
    console.log('  --------|-----------|-----------|-----------|-----------|--------');
    console.log(
      `  Plain   | ${plainStats.avg.toFixed(2).padStart(8)} | ${plainStats.p50.toFixed(2).padStart(8)} ` +
      `| ${plainStats.p95.toFixed(2).padStart(8)} | ${plainStats.p99.toFixed(2).padStart(8)} | ${plainOpsPerSec.toFixed(0).padStart(6)}`,
    );
    console.log(
      `  Encrypt | ${encStats.avg.toFixed(2).padStart(8)} | ${encStats.p50.toFixed(2).padStart(8)} ` +
      `| ${encStats.p95.toFixed(2).padStart(8)} | ${encStats.p99.toFixed(2).padStart(8)} | ${encOpsPerSec.toFixed(0).padStart(6)}`,
    );
    const avgOverhead = ((encStats.avg / plainStats.avg - 1) * 100).toFixed(1);
    console.log(`  Overhead: +${avgOverhead}% avg latency`);

    // Verify encrypted WAL data is correct
    const verifyDriver = createConcurrentFileDriver({ directory: encDir, wal: true, encryption: { key: TEST_KEY } });
    const verifyInst = await create({ dimensions: dims, storageDriver: verifyDriver, collectionId: 'wal', autoFlush: false });
    expect((verifyInst as unknown as TrovecInstance).entries.size).toBe(totalAppends + 1);

    await rm(plainDir, { recursive: true, force: true });
    await rm(encDir, { recursive: true, force: true });
  }, 120_000);

  it('6.3 encryption overhead: large vectors (768, 1536 dimensions)', async () => {
    const dimSets = [768, 1536];
    const entriesPerSet = 1_000;

    console.log('\n6.3 Encryption overhead for large vectors:');
    console.log('  Dims  |  Flush(ms)    |  Read(ms)     |  File size');
    console.log('        | plain   enc   | plain   enc   | plain     enc');
    console.log('  ------|---------------|---------------|------------------');

    for (const dims of dimSets) {
      const entries = Array.from({ length: entriesPerSet }, (_, i) => ({
        id: `e-${i}`,
        embedding: randomEmbedding(dims),
      }));

      const plainDir = await mkdtemp(join(tmpdir(), `trovec-enc-lv-plain-${dims}-`));
      const encDir = await mkdtemp(join(tmpdir(), `trovec-enc-lv-enc-${dims}-`));

      try {
        // Plain
        const plainDriver = createConcurrentFileDriver({ directory: plainDir });
        const plainInst = await create({ dimensions: dims, storageDriver: plainDriver, collectionId: 'lv', autoFlush: false });
        addMany(plainInst as unknown as TrovecInstance, entries);
        const { durationMs: plainFlush } = await measure(async () => { await flush(plainInst as unknown as TrovecInstance); });
        await close(plainInst as unknown as TrovecInstance);
        const plainFile = await stat(join(plainDir, 'lv.trovec'));
        const { durationMs: plainRead } = await measure(async () => {
          const d = createConcurrentFileDriver({ directory: plainDir });
          await create({ dimensions: dims, storageDriver: d, collectionId: 'lv', autoFlush: false });
        });

        // Encrypted
        const encDriver = createConcurrentFileDriver({ directory: encDir, encryption: { key: TEST_KEY } });
        const encInst = await create({ dimensions: dims, storageDriver: encDriver, collectionId: 'lv', autoFlush: false });
        addMany(encInst as unknown as TrovecInstance, entries);
        const { durationMs: encFlush } = await measure(async () => { await flush(encInst as unknown as TrovecInstance); });
        await close(encInst as unknown as TrovecInstance);
        const encFile = await stat(join(encDir, 'lv.trovec'));
        const { durationMs: encRead } = await measure(async () => {
          const d = createConcurrentFileDriver({ directory: encDir, encryption: { key: TEST_KEY } });
          await create({ dimensions: dims, storageDriver: d, collectionId: 'lv', autoFlush: false });
        });

        console.log(
          `  ${String(dims).padStart(5)} ` +
          `| ${plainFlush.toFixed(0).padStart(5)}  ${encFlush.toFixed(0).padStart(5)} ` +
          `| ${plainRead.toFixed(0).padStart(5)}  ${encRead.toFixed(0).padStart(5)} ` +
          `| ${(plainFile.size / 1024).toFixed(0).padStart(7)}KB ${(encFile.size / 1024).toFixed(0).padStart(7)}KB`,
        );
      } finally {
        await rm(plainDir, { recursive: true, force: true });
        await rm(encDir, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it('6.4 withEncryption wrapper vs concurrent driver built-in', async () => {
    const dims = 128;
    const entryCount = 10_000;

    console.log('\n6.4 Wrapper vs built-in encryption (10K x 128d):');

    const entries = Array.from({ length: entryCount }, (_, i) => ({
      id: `e-${i}`,
      embedding: randomEmbedding(dims),
    }));

    // --- withEncryption wrapper ---
    const wrapDir = await mkdtemp(join(tmpdir(), 'trovec-enc-wrap-'));
    const wrapDriver = withEncryption(createFileDriver({ directory: wrapDir }), { key: TEST_KEY });
    const wrapInst = await create({ dimensions: dims, storageDriver: wrapDriver, collectionId: 'bench', autoFlush: false });
    addMany(wrapInst as unknown as TrovecInstance, entries);
    const { durationMs: wrapFlush } = await measure(async () => {
      await flush(wrapInst as unknown as TrovecInstance);
    });
    await close(wrapInst as unknown as TrovecInstance);
    const wrapFile = await stat(join(wrapDir, 'bench.trovec'));
    const { durationMs: wrapRead } = await measure(async () => {
      const d = withEncryption(createFileDriver({ directory: wrapDir }), { key: TEST_KEY });
      const i = await create({ dimensions: dims, storageDriver: d, collectionId: 'bench', autoFlush: false });
      expect((i as unknown as TrovecInstance).entries.size).toBe(entryCount);
    });

    // --- Built-in on concurrent driver ---
    const builtinDir = await mkdtemp(join(tmpdir(), 'trovec-enc-builtin-'));
    const builtinDriver = createConcurrentFileDriver({ directory: builtinDir, encryption: { key: TEST_KEY } });
    const builtinInst = await create({ dimensions: dims, storageDriver: builtinDriver, collectionId: 'bench', autoFlush: false });
    addMany(builtinInst as unknown as TrovecInstance, entries);
    const { durationMs: builtinFlush } = await measure(async () => {
      await flush(builtinInst as unknown as TrovecInstance);
    });
    await close(builtinInst as unknown as TrovecInstance);
    const builtinFile = await stat(join(builtinDir, 'bench.trovec'));
    const { durationMs: builtinRead } = await measure(async () => {
      const d = createConcurrentFileDriver({ directory: builtinDir, encryption: { key: TEST_KEY } });
      const i = await create({ dimensions: dims, storageDriver: d, collectionId: 'bench', autoFlush: false });
      expect((i as unknown as TrovecInstance).entries.size).toBe(entryCount);
    });

    console.log('  Method     |  Flush(ms)  |  Read(ms)  |  File size');
    console.log('  -----------|-------------|------------|----------');
    console.log(
      `  Wrapper    | ${wrapFlush.toFixed(0).padStart(9)} | ${wrapRead.toFixed(0).padStart(8)} | ${(wrapFile.size / 1024).toFixed(0).padStart(6)}KB`,
    );
    console.log(
      `  Built-in   | ${builtinFlush.toFixed(0).padStart(9)} | ${builtinRead.toFixed(0).padStart(8)} | ${(builtinFile.size / 1024).toFixed(0).padStart(6)}KB`,
    );

    await rm(wrapDir, { recursive: true, force: true });
    await rm(builtinDir, { recursive: true, force: true });
  }, 60_000);

  it('6.5 encrypted concurrent multi-process writes (WAL)', async () => {
    const dims = 128;
    const processCount = 4;
    const opsPerWorker = 50;
    const keyHex = TEST_KEY.toString('hex');

    console.log(`\n6.5 Encrypted multi-process WAL (${processCount} processes, ${opsPerWorker} ops each, ${dims}d):`);

    // Seed the collection
    const driver = createConcurrentFileDriver({ directory: dir, wal: true, encryption: { key: TEST_KEY } });
    const seedInst = await create({ dimensions: dims, storageDriver: driver, collectionId: 'mproc', autoFlush: false });
    add(seedInst as unknown as TrovecInstance, { id: 'seed', embedding: randomEmbedding(dims) });
    await flush(seedInst as unknown as TrovecInstance);
    await close(seedInst as unknown as TrovecInstance);

    // Spawn workers
    const workerProcs: ChildProcess[] = [];
    for (let i = 0; i < processCount; i++) {
      const { proc, ready } = await spawnWorker();
      workerProcs.push(proc);
      workers.push(proc);
      await ready;
      await sendCommand(proc, {
        type: 'init',
        dir,
        collectionId: 'mproc',
        dimensions: dims,
        wal: true,
        encryptionKeyHex: keyHex,
      });
    }

    // Run concurrent writes
    const allDurations: number[] = [];
    const { durationMs: totalMs } = await measure(async () => {
      const tasks = workerProcs.map(async (proc, wIdx) => {
        for (let i = 0; i < opsPerWorker; i++) {
          const flushStart = performance.now();
          await sendCommand(proc, {
            type: 'add',
            id: `w${wIdx}-e${i}`,
            embedding: randomEmbedding(dims),
          });
          const res = await sendCommand(proc, { type: 'flush' });
          if (!res.success) throw new Error(`Flush failed: ${res.error}`);
          allDurations.push(performance.now() - flushStart);
        }
      });
      await Promise.all(tasks);
    });

    // Close workers
    for (const proc of workerProcs) {
      await sendCommand(proc, { type: 'close' });
    }

    const totalOps = processCount * opsPerWorker;
    const flushStats = computeStats(allDurations);
    const throughput = (totalOps / totalMs) * 1000;

    console.log(`  Total: ${totalOps} ops in ${totalMs.toFixed(0)}ms (${throughput.toFixed(0)} ops/sec)`);
    console.log(`  Flush: avg=${flushStats.avg.toFixed(1)}ms p50=${flushStats.p50.toFixed(1)}ms p95=${flushStats.p95.toFixed(1)}ms p99=${flushStats.p99.toFixed(1)}ms max=${flushStats.max.toFixed(0)}ms`);

    // Verify all data
    const verifyDriver = createConcurrentFileDriver({ directory: dir, wal: true, encryption: { key: TEST_KEY } });
    const verifyInst = await create({ dimensions: dims, storageDriver: verifyDriver, collectionId: 'mproc', autoFlush: false });
    const verifyCount = (verifyInst as unknown as TrovecInstance).entries.size;
    console.log(`  Verified: ${verifyCount} entries (expected ${totalOps + 1})`);
    expect(verifyCount).toBe(totalOps + 1);
  }, 120_000);

  it('6.6 password-based key derivation overhead', async () => {
    const dims = 128;
    const entryCount = 5_000;
    const iterations = [1_000, 10_000, 100_000];

    console.log('\n6.6 Password-based key derivation overhead (5K x 128d):');
    console.log('  Iterations  |  Flush(ms)  |  Read(ms)');
    console.log('  ------------|-------------|----------');

    const entries = Array.from({ length: entryCount }, (_, i) => ({
      id: `e-${i}`,
      embedding: randomEmbedding(dims),
    }));

    // Raw key baseline
    const rawDir = await mkdtemp(join(tmpdir(), 'trovec-enc-raw-'));
    const rawDriver = withEncryption(createFileDriver({ directory: rawDir }), { key: TEST_KEY });
    const rawInst = await create({ dimensions: dims, storageDriver: rawDriver, collectionId: 'pw', autoFlush: false });
    addMany(rawInst as unknown as TrovecInstance, entries);
    const { durationMs: rawFlush } = await measure(async () => { await flush(rawInst as unknown as TrovecInstance); });
    await close(rawInst as unknown as TrovecInstance);
    const { durationMs: rawRead } = await measure(async () => {
      const d = withEncryption(createFileDriver({ directory: rawDir }), { key: TEST_KEY });
      await create({ dimensions: dims, storageDriver: d, collectionId: 'pw', autoFlush: false });
    });
    console.log(`  Raw key     | ${rawFlush.toFixed(0).padStart(9)} | ${rawRead.toFixed(0).padStart(8)}`);

    for (const iter of iterations) {
      const pwDir = await mkdtemp(join(tmpdir(), `trovec-enc-pw${iter}-`));
      try {
        const pwDriver = withEncryption(createFileDriver({ directory: pwDir }), { password: 'benchmark-pass', iterations: iter });
        const pwInst = await create({ dimensions: dims, storageDriver: pwDriver, collectionId: 'pw', autoFlush: false });
        addMany(pwInst as unknown as TrovecInstance, entries);
        const { durationMs: pwFlush } = await measure(async () => { await flush(pwInst as unknown as TrovecInstance); });
        await close(pwInst as unknown as TrovecInstance);
        const { durationMs: pwRead } = await measure(async () => {
          const d = withEncryption(createFileDriver({ directory: pwDir }), { password: 'benchmark-pass', iterations: iter });
          await create({ dimensions: dims, storageDriver: d, collectionId: 'pw', autoFlush: false });
        });
        console.log(`  ${String(iter).padStart(10)}  | ${pwFlush.toFixed(0).padStart(9)} | ${pwRead.toFixed(0).padStart(8)}`);
      } finally {
        await rm(pwDir, { recursive: true, force: true });
      }
    }

    await rm(rawDir, { recursive: true, force: true });
  }, 60_000);
});
