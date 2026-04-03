/**
 * Child process worker for multi-process concurrency tests.
 *
 * Receives IPC commands from the parent and operates its own independent
 * ConcurrentFileDriver + Trovec instance. This ensures real OS-level PID
 * isolation for testing file locking across processes.
 *
 * Run via: child_process.fork('tests/fixtures/worker.ts', [], { execArgv: ['--import', 'tsx'] })
 */
import { createConcurrentFileDriver } from '../../src/storage/concurrent-file.js';
import { create, flush, close } from '../../src/core.js';
import { add, addMany, get, del } from '../../src/collection.js';
import type { Trovec, TrovecInstance } from '../../src/types.js';

interface InitCommand {
  type: 'init';
  dir: string;
  collectionId: string;
  dimensions: number;
  wal?: boolean;
  quantization?: 'F32' | 'INT8' | 'BIT';
  metric?: 'cosine' | 'euclidean' | 'dot' | 'hamming';
  staleLockTimeout?: number;
  lockAcquireTimeout?: number;
  lockRetryInterval?: number;
}

interface AddCommand {
  type: 'add';
  id: string;
  embedding: number[];
  context?: Record<string, unknown>;
}

interface AddManyCommand {
  type: 'addMany';
  entries: Array<{ id: string; embedding: number[]; context?: Record<string, unknown> }>;
}

interface DeleteCommand {
  type: 'delete';
  id: string;
}

interface FlushCommand {
  type: 'flush';
}

interface ReadCommand {
  type: 'read';
}

interface CloseCommand {
  type: 'close';
}

interface GetStatsCommand {
  type: 'stats';
}

interface GetCommand {
  type: 'get';
  id: string;
}

interface SignalCommand {
  type: 'signal';
  signal: string;
}

interface SlowFlushCommand {
  type: 'slow-flush';
  delayMs: number;
}

type WorkerCommand =
  | InitCommand
  | AddCommand
  | AddManyCommand
  | DeleteCommand
  | FlushCommand
  | ReadCommand
  | CloseCommand
  | GetStatsCommand
  | GetCommand
  | SignalCommand
  | SlowFlushCommand;

interface WorkerResult {
  type: 'result';
  success: boolean;
  data?: unknown;
  error?: string;
}

let instance: Trovec | null = null;

function send(msg: WorkerResult): void {
  process.send!(msg);
}

async function handleCommand(cmd: WorkerCommand): Promise<void> {
  try {
    switch (cmd.type) {
      case 'init': {
        const driver = createConcurrentFileDriver({
          directory: cmd.dir,
          wal: cmd.wal ?? false,
          staleLockTimeout: cmd.staleLockTimeout,
          lockAcquireTimeout: cmd.lockAcquireTimeout,
          lockRetryInterval: cmd.lockRetryInterval,
        });
        instance = await create({
          dimensions: cmd.dimensions,
          storageDriver: driver,
          collectionId: cmd.collectionId,
          quantization: cmd.quantization ?? 'F32',
          metric: cmd.metric ?? 'cosine',
          autoFlush: false,
        });
        send({ type: 'result', success: true });
        break;
      }

      case 'add': {
        if (!instance) throw new Error('Not initialized');
        add(instance as unknown as TrovecInstance, {
          id: cmd.id,
          embedding: cmd.embedding,
          context: cmd.context,
        });
        send({ type: 'result', success: true });
        break;
      }

      case 'addMany': {
        if (!instance) throw new Error('Not initialized');
        addMany(instance as unknown as TrovecInstance, cmd.entries);
        send({ type: 'result', success: true });
        break;
      }

      case 'delete': {
        if (!instance) throw new Error('Not initialized');
        const existed = del(instance as unknown as TrovecInstance, cmd.id);
        send({ type: 'result', success: true, data: existed });
        break;
      }

      case 'flush': {
        if (!instance) throw new Error('Not initialized');
        await flush(instance as unknown as TrovecInstance);
        send({ type: 'result', success: true });
        break;
      }

      case 'read': {
        if (!instance) throw new Error('Not initialized');
        const entryCount = (instance as unknown as TrovecInstance).entries.size;
        send({ type: 'result', success: true, data: { entryCount } });
        break;
      }

      case 'stats': {
        if (!instance) throw new Error('Not initialized');
        const inst = instance as unknown as TrovecInstance;
        send({
          type: 'result',
          success: true,
          data: {
            entryCount: inst.entries.size,
            dirty: inst.dirty,
          },
        });
        break;
      }

      case 'get': {
        if (!instance) throw new Error('Not initialized');
        const entry = get(instance as unknown as TrovecInstance, cmd.id);
        send({
          type: 'result',
          success: true,
          data: entry ? { id: entry.id, embedding: Array.from(entry.embedding) } : null,
        });
        break;
      }

      case 'close': {
        if (instance) {
          await close(instance as unknown as TrovecInstance);
          instance = null;
        }
        send({ type: 'result', success: true });
        break;
      }

      case 'signal': {
        send({ type: 'result', success: true, data: cmd.signal });
        break;
      }

      case 'slow-flush': {
        if (!instance) throw new Error('Not initialized');
        // Signal that we're about to start flushing
        send({ type: 'result', success: true, data: 'flush-starting' });
        // Add a small delay to keep the lock held longer
        await flush(instance as unknown as TrovecInstance);
        await new Promise((r) => setTimeout(r, cmd.delayMs));
        send({ type: 'result', success: true, data: 'flush-done' });
        break;
      }

      default:
        send({ type: 'result', success: false, error: `Unknown command: ${(cmd as WorkerCommand).type}` });
    }
  } catch (err: unknown) {
    send({
      type: 'result',
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

process.on('message', (msg: WorkerCommand) => {
  handleCommand(msg).catch((err) => {
    send({ type: 'result', success: false, error: String(err) });
  });
});

// Signal ready
send({ type: 'result', success: true, data: 'ready' });
