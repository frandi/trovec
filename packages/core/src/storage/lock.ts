import { open, readFile, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { LockTimeoutError } from '../errors.js';

export interface LockOptions {
  staleLockTimeout: number;
  lockAcquireTimeout: number;
  lockRetryInterval: number;
}

export interface Lock {
  release(): Promise<void>;
}

interface LockMetadata {
  pid: number;
  hostname: string;
  timestamp: number;
  heartbeat: number;
}

const DEFAULT_OPTIONS: LockOptions = {
  staleLockTimeout: 30_000,
  lockAcquireTimeout: 10_000,
  lockRetryInterval: 200,
};

function createMetadata(): LockMetadata {
  return {
    pid: process.pid,
    hostname: hostname(),
    timestamp: Date.now(),
    heartbeat: Date.now(),
  };
}

async function tryCreateLockFile(lockPath: string): Promise<boolean> {
  try {
    const fd = await open(lockPath, 'wx');
    await fd.writeFile(JSON.stringify(createMetadata()));
    await fd.close();
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

async function readLockMetadata(lockPath: string): Promise<LockMetadata | null> {
  try {
    const data = await readFile(lockPath, 'utf-8');
    return JSON.parse(data) as LockMetadata;
  } catch {
    return null;
  }
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  try {
    await unlink(lockPath);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }
}

export async function acquireLock(lockPath: string, options?: Partial<LockOptions>): Promise<Lock> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const deadline = Date.now() + opts.lockAcquireTimeout;

  while (true) {
    if (await tryCreateLockFile(lockPath)) {
      break;
    }

    // Lock file exists — check if stale
    const meta = await readLockMetadata(lockPath);
    if (meta && (Date.now() - meta.heartbeat) > opts.staleLockTimeout) {
      await removeStaleLock(lockPath);
      continue;
    }

    if (Date.now() >= deadline) {
      throw new LockTimeoutError(lockPath, opts.lockAcquireTimeout);
    }

    await new Promise((r) => setTimeout(r, opts.lockRetryInterval));
  }

  // Start heartbeat
  const heartbeatInterval = setInterval(async () => {
    try {
      const meta = createMetadata();
      await writeFile(lockPath, JSON.stringify(meta));
    } catch {
      // Lock file may have been removed externally — ignore
    }
  }, Math.min(opts.staleLockTimeout / 3, 5_000));
  heartbeatInterval.unref();

  let released = false;

  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      clearInterval(heartbeatInterval);
      await removeStaleLock(lockPath);
    },
  };
}
