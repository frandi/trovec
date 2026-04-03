import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLock } from '../../src/storage/lock.js';
import { LockTimeoutError } from '../../src/errors.js';

describe('File Lock', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'trovec-lock-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('acquires and releases a lock', async () => {
    const lockPath = join(dir, 'test.lock');
    const lock = await acquireLock(lockPath);

    // Lock file should exist with metadata
    const meta = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(meta.pid).toBe(process.pid);
    expect(typeof meta.hostname).toBe('string');
    expect(typeof meta.timestamp).toBe('number');

    await lock.release();
  });

  it('release is idempotent', async () => {
    const lockPath = join(dir, 'test.lock');
    const lock = await acquireLock(lockPath);
    await lock.release();
    await lock.release(); // should not throw
  });

  it('second acquire blocks until first releases', async () => {
    const lockPath = join(dir, 'test.lock');
    const lock1 = await acquireLock(lockPath);

    const events: string[] = [];

    const lock2Promise = (async () => {
      events.push('waiting');
      const lock = await acquireLock(lockPath, { lockAcquireTimeout: 5000, lockRetryInterval: 50, staleLockTimeout: 30_000 });
      events.push('acquired');
      return lock;
    })();

    // Give the second acquire a moment to start waiting
    await new Promise((r) => setTimeout(r, 200));
    expect(events).toEqual(['waiting']);

    await lock1.release();

    const lock2 = await lock2Promise;
    expect(events).toEqual(['waiting', 'acquired']);
    await lock2.release();
  });

  it('throws LockTimeoutError when lock cannot be acquired in time', async () => {
    const lockPath = join(dir, 'test.lock');
    const lock1 = await acquireLock(lockPath);

    await expect(
      acquireLock(lockPath, { lockAcquireTimeout: 300, lockRetryInterval: 50, staleLockTimeout: 30_000 }),
    ).rejects.toThrow(LockTimeoutError);

    await lock1.release();
  });

  it('detects and recovers stale locks', async () => {
    const lockPath = join(dir, 'test.lock');

    // Acquire and release — but simulate a stale lock by re-creating with old timestamp
    const lock1 = await acquireLock(lockPath);
    await lock1.release();

    // Write a stale lock file manually
    const { writeFile } = await import('node:fs/promises');
    const staleMeta = {
      pid: 99999,
      hostname: 'stale-host',
      timestamp: Date.now() - 60_000,
      heartbeat: Date.now() - 60_000,
    };
    await writeFile(lockPath, JSON.stringify(staleMeta));

    // Should succeed since the lock is stale
    const lock2 = await acquireLock(lockPath, { staleLockTimeout: 1000 });
    const meta = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(meta.pid).toBe(process.pid);
    await lock2.release();
  });
});
