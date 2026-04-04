import { writeFile as fsWriteFile, readFile, access, unlink, rename, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { acquireLock } from './lock.js';
import { appendWalEntries, readWalEntries, replayWal, deleteWal } from './wal.js';
import type { WalTransforms } from './wal.js';
import { resolveEncryptionKey, encryptBuffer, decryptBuffer } from './encryption.js';
import type { ResolvedEncryption } from './encryption.js';
import type {
  ConcurrentFileDriverOptions,
  ConcurrentFileStorageDriver,
  WalAwareDriver,
  WalOperation,
  EntryId,
  QuantizedVector,
} from '../types.js';

const DEFAULT_DIRECTORY = '.trovec';

/**
 * Thrown internally when WAL append is attempted before the driver knows
 * the collection's dimensions/quantization. Core flush logic catches this
 * and falls back to a full-buffer write.
 */
export class WalConfigNotReady extends Error {
  constructor() {
    super('WAL config not ready');
    this.name = 'WalConfigNotReady';
  }
}

/**
 * Create a concurrent file-based storage driver with file locking and optional WAL support.
 *
 * When `wal` is disabled (default), this driver behaves like `createFileDriver` but wraps
 * all operations with an exclusive file lock to prevent corruption from concurrent access.
 *
 * When `wal` is enabled, mutations are appended to a Write-Ahead Log instead of rewriting
 * the entire collection file. The WAL is automatically compacted (checkpointed) when the
 * entry count exceeds `checkpointThreshold`.
 *
 * @param options - Configuration for directory, compression, locking, and WAL behavior.
 * @returns A driver implementing both {@link ConcurrentFileStorageDriver} and optionally {@link WalAwareDriver}.
 *
 * @example
 * ```ts
 * // Locking only (safe multi-process, full-rewrite on flush)
 * const driver = createConcurrentFileDriver({ directory: './data' });
 *
 * // WAL enabled (fast appends, auto-checkpoint)
 * const walDriver = createConcurrentFileDriver({
 *   directory: './data',
 *   wal: true,
 *   checkpointThreshold: 500,
 * });
 * ```
 */
export function createConcurrentFileDriver(
  options: ConcurrentFileDriverOptions = {},
): ConcurrentFileStorageDriver & WalAwareDriver {
  const {
    directory = DEFAULT_DIRECTORY,
    compression = true,
    compressionLevel = 1,
    staleLockTimeout = 30_000,
    lockAcquireTimeout = 10_000,
    lockRetryInterval = 200,
    wal: walEnabled = false,
    encryption,
  } = options;

  const resolvedDir = resolve(directory);
  let dirEnsured = false;

  // Resolve encryption at creation time (validates options eagerly)
  const resolvedEncryption: ResolvedEncryption | null = encryption
    ? resolveEncryptionKey(encryption)
    : null;

  const walTransforms: WalTransforms | undefined = resolvedEncryption
    ? {
        encrypt: (buf: Buffer) => encryptBuffer(buf, resolvedEncryption),
        decrypt: (buf: Buffer) => decryptBuffer(buf, resolvedEncryption),
      }
    : undefined;

  // Track WAL sequence numbers per collection
  const walSequences = new Map<string, number>();
  const walEntryCounts = new Map<string, number>();

  async function ensureDir(): Promise<void> {
    if (dirEnsured) return;
    await mkdir(resolvedDir, { recursive: true });
    dirEnsured = true;
  }

  function filePath(collectionId: string): string {
    return join(resolvedDir, `${collectionId}.trovec`);
  }

  function walPath(collectionId: string): string {
    return join(resolvedDir, `${collectionId}.trovec.wal`);
  }

  function lockPath(collectionId: string): string {
    return join(resolvedDir, `${collectionId}.trovec.lock`);
  }

  const lockOpts = { staleLockTimeout, lockAcquireTimeout, lockRetryInterval };

  function compress(data: Buffer): Buffer {
    if (!compression) return data;
    return brotliCompressSync(data, {
      params: { [constants.BROTLI_PARAM_QUALITY]: compressionLevel },
    });
  }

  function decompress(data: Buffer): Buffer {
    if (!compression) return data;
    return brotliDecompressSync(data);
  }

  async function readBaseFile(collectionId: string): Promise<Buffer | null> {
    try {
      let raw: Buffer = await readFile(filePath(collectionId));
      if (resolvedEncryption) {
        raw = decryptBuffer(raw, resolvedEncryption);
      }
      return decompress(raw);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async function writeBaseFile(collectionId: string, data: Buffer): Promise<void> {
    await ensureDir();
    const target = filePath(collectionId);
    const tmp = `${target}.tmp`;
    let output = compress(data);
    if (resolvedEncryption) {
      output = encryptBuffer(output, resolvedEncryption);
    }
    await fsWriteFile(tmp, output);
    await rename(tmp, target);
  }

  // Extract config from a serialized buffer header for WAL operations
  function extractConfigFromBuffer(data: Buffer): { dimensions: number; quantization: 'F32' | 'INT8' | 'BIT' } | null {
    if (data.length < 16) return null;
    const QUANT_REVERSE: Array<'F32' | 'INT8' | 'BIT'> = ['F32', 'INT8', 'BIT'];
    return {
      dimensions: data.readUInt32LE(5),
      quantization: QUANT_REVERSE[data.readUInt8(9)],
    };
  }

  // Store config per collection (learned from first write, read, or explicit setConfig)
  const collectionConfigs = new Map<string, { dimensions: number; quantization: 'F32' | 'INT8' | 'BIT' }>();

  function getOrLearnConfig(collectionId: string, data: Buffer): { dimensions: number; quantization: 'F32' | 'INT8' | 'BIT' } | null {
    let config = collectionConfigs.get(collectionId);
    if (config) return config;
    config = extractConfigFromBuffer(data) ?? undefined;
    if (config) collectionConfigs.set(collectionId, config);
    return config ?? null;
  }


  const driver: ConcurrentFileStorageDriver & WalAwareDriver = {
    get walEnabled(): true {
      return walEnabled as true;
    },

    get directory() {
      return resolvedDir;
    },

    async write(collectionId: string, data: Buffer): Promise<void> {
      await ensureDir();
      const lock = await acquireLock(lockPath(collectionId), lockOpts);
      try {
        // Learn config from the data being written
        getOrLearnConfig(collectionId, data);
        await writeBaseFile(collectionId, data);

        // If WAL exists, delete it since we just wrote a full snapshot
        if (walEnabled) {
          await deleteWal(walPath(collectionId));
          walSequences.set(collectionId, 0);
          walEntryCounts.set(collectionId, 0);
        }
      } finally {
        await lock.release();
      }
    },

    async read(collectionId: string): Promise<Buffer | null> {
      await ensureDir();
      const lock = await acquireLock(lockPath(collectionId), lockOpts);
      try {
        const baseData = await readBaseFile(collectionId);

        if (!walEnabled || !baseData) {
          if (baseData) getOrLearnConfig(collectionId, baseData);
          return baseData;
        }

        const config = getOrLearnConfig(collectionId, baseData);
        if (!config) return baseData;

        // Read and replay WAL on top of base data
        const walResult = await readWalEntries(walPath(collectionId), config, walTransforms);

        if (walResult.entries.length === 0) {
          walSequences.set(collectionId, walResult.nextSequence);
          return baseData;
        }

        // Deserialize base data into a temporary map, replay WAL, re-serialize
        const tempEntries = new Map<string, { id: EntryId; quantized: QuantizedVector; context?: Record<string, unknown> }>();
        deserializeToMap(baseData, tempEntries, config);
        replayWal(walResult.entries, tempEntries);
        const merged = serializeFromMap(tempEntries, config, baseData);

        walSequences.set(collectionId, walResult.nextSequence);
        walEntryCounts.set(collectionId, walResult.entries.length);

        return merged;
      } finally {
        await lock.release();
      }
    },

    async exists(collectionId: string): Promise<boolean> {
      try {
        await access(filePath(collectionId));
        return true;
      } catch {
        // Also check for WAL-only state
        if (walEnabled) {
          try {
            await access(walPath(collectionId));
            return true;
          } catch {
            return false;
          }
        }
        return false;
      }
    },

    async delete(collectionId: string): Promise<boolean> {
      await ensureDir();
      const lock = await acquireLock(lockPath(collectionId), lockOpts);
      try {
        let existed = false;
        try {
          await unlink(filePath(collectionId));
          existed = true;
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }

        if (walEnabled) {
          await deleteWal(walPath(collectionId));
          walSequences.delete(collectionId);
          walEntryCounts.delete(collectionId);
        }

        collectionConfigs.delete(collectionId);
        return existed;
      } finally {
        await lock.release();
      }
    },

    async destroy(): Promise<void> {
      await rm(resolvedDir, { recursive: true, force: true });
      dirEnsured = false;
      walSequences.clear();
      walEntryCounts.clear();
      collectionConfigs.clear();
    },

    async appendWal(collectionId: string, ops: WalOperation[]): Promise<void> {
      if (!walEnabled || ops.length === 0) return;

      const config = collectionConfigs.get(collectionId);
      if (!config) {
        // Config unknown — this happens on fresh collections where read() returned null.
        // Signal to core.ts that WAL append is not possible yet by throwing a
        // specific error. The flush logic in core.ts will fall back to a full write.
        throw new WalConfigNotReady();
      }

      const lock = await acquireLock(lockPath(collectionId), lockOpts);
      try {
        const seq = walSequences.get(collectionId) ?? 0;
        const nextSeq = await appendWalEntries(walPath(collectionId), ops, seq, config, walTransforms);
        walSequences.set(collectionId, nextSeq);

        const count = (walEntryCounts.get(collectionId) ?? 0) + ops.length;
        walEntryCounts.set(collectionId, count);
      } finally {
        await lock.release();
      }
    },

    async checkpoint(collectionId: string, data?: Buffer): Promise<void> {
      if (!walEnabled) return;

      const lock = await acquireLock(lockPath(collectionId), lockOpts);
      try {
        if (data) {
          // Write the provided full snapshot as the base file
          await writeBaseFile(collectionId, data);
        }
        await deleteWal(walPath(collectionId));
        walSequences.set(collectionId, 0);
        walEntryCounts.set(collectionId, 0);
      } finally {
        await lock.release();
      }
    },
  };

  return driver;
}

// --- Internal helpers for WAL replay during read ---

function deserializeToMap(
  buffer: Buffer,
  entries: Map<string, { id: EntryId; quantized: QuantizedVector; context?: Record<string, unknown> }>,
  _config: { dimensions: number; quantization: 'F32' | 'INT8' | 'BIT' },
): void {
  const HEADER_SIZE = 16;
  if (buffer.length < HEADER_SIZE) return;

  const dimensions = buffer.readUInt32LE(5);
  const QUANT_REVERSE: Array<'F32' | 'INT8' | 'BIT'> = ['F32', 'INT8', 'BIT'];
  const quantization = QUANT_REVERSE[buffer.readUInt8(9)];
  const entryCount = buffer.readUInt32LE(11);

  let offset = HEADER_SIZE;

  for (let i = 0; i < entryCount; i++) {
    const idType = buffer.readUInt8(offset); offset += 1;
    const idLen = buffer.readUInt32LE(offset); offset += 4;
    const idStr = buffer.toString('utf-8', offset, offset + idLen); offset += idLen;

    const id: EntryId = idType === 1 ? BigInt(idStr) : idStr;

    const { quantized, offset: newOffset } = readQuantizedDataInternal(buffer, offset, quantization, dimensions);
    offset = newOffset;

    const contextLen = buffer.readUInt32LE(offset); offset += 4;
    let context: Record<string, unknown> | undefined;
    if (contextLen > 0) {
      const contextStr = buffer.toString('utf-8', offset, offset + contextLen);
      context = JSON.parse(contextStr) as Record<string, unknown>;
      offset += contextLen;
    }

    const key = typeof id === 'bigint' ? `__bigint__:${id.toString()}` : id;
    entries.set(key, { id, quantized, context });
  }
}

function serializeFromMap(
  entries: Map<string, { id: EntryId; quantized: QuantizedVector; context?: Record<string, unknown> }>,
  config: { dimensions: number; quantization: 'F32' | 'INT8' | 'BIT' },
  originalBuffer: Buffer,
): Buffer {
  // Re-use the metric byte from the original buffer header
  const metricByte = originalBuffer.length >= 11 ? originalBuffer.readUInt8(10) : 0;

  const MAGIC = Buffer.from('VCR\x01');
  const VERSION = 1;
  const HEADER_SIZE = 16;
  const QUANT_MAP: Record<string, number> = { F32: 0, INT8: 1, BIT: 2 };

  const allEntries = Array.from(entries.values());

  let totalSize = HEADER_SIZE;
  const prepared: { idType: number; idBuf: Buffer; quantized: QuantizedVector; contextBuf: Buffer | null }[] = [];

  for (const entry of allEntries) {
    const idType = typeof entry.id === 'bigint' ? 1 : 0;
    const idStr = typeof entry.id === 'bigint' ? entry.id.toString() : (entry.id as string);
    const idBuf = Buffer.from(idStr, 'utf-8');
    const contextBuf = entry.context ? Buffer.from(JSON.stringify(entry.context), 'utf-8') : null;

    totalSize += 1 + 4 + idBuf.length;
    totalSize += quantizedDataSizeInternal(config.quantization, config.dimensions);
    totalSize += 4 + (contextBuf ? contextBuf.length : 0);

    prepared.push({ idType, idBuf, quantized: entry.quantized, contextBuf });
  }

  const buf = Buffer.alloc(totalSize);
  let offset = 0;

  MAGIC.copy(buf, offset); offset += 4;
  buf.writeUInt8(VERSION, offset); offset += 1;
  buf.writeUInt32LE(config.dimensions, offset); offset += 4;
  buf.writeUInt8(QUANT_MAP[config.quantization], offset); offset += 1;
  buf.writeUInt8(metricByte, offset); offset += 1;
  buf.writeUInt32LE(allEntries.length, offset); offset += 4;
  buf.writeUInt8(0, offset); offset += 1; // reserved

  for (const { idType, idBuf, quantized, contextBuf } of prepared) {
    buf.writeUInt8(idType, offset); offset += 1;
    buf.writeUInt32LE(idBuf.length, offset); offset += 4;
    idBuf.copy(buf, offset); offset += idBuf.length;

    offset = writeQuantizedDataInternal(buf, offset, quantized, config.quantization);

    const contextLen = contextBuf ? contextBuf.length : 0;
    buf.writeUInt32LE(contextLen, offset); offset += 4;
    if (contextBuf) {
      contextBuf.copy(buf, offset); offset += contextBuf.length;
    }
  }

  return buf;
}

// Duplicated from serialization.ts to avoid circular dependency concerns
// and to keep the WAL replay self-contained within the storage layer.

function quantizedDataSizeInternal(quantization: string, dimensions: number): number {
  switch (quantization) {
    case 'F32': return dimensions * 8;
    case 'INT8': return 16 + dimensions;
    case 'BIT': return Math.ceil(dimensions / 8);
    default: return 0;
  }
}

function writeQuantizedDataInternal(buf: Buffer, offset: number, quantized: QuantizedVector, quantization: string): number {
  switch (quantization) {
    case 'F32': {
      const data = quantized.data as Float64Array;
      for (let i = 0; i < data.length; i++) {
        buf.writeDoubleLE(data[i], offset);
        offset += 8;
      }
      return offset;
    }
    case 'INT8': {
      buf.writeDoubleLE(quantized.min!, offset); offset += 8;
      buf.writeDoubleLE(quantized.max!, offset); offset += 8;
      const data = quantized.data as Int8Array;
      for (let i = 0; i < data.length; i++) {
        buf.writeInt8(data[i], offset);
        offset += 1;
      }
      return offset;
    }
    case 'BIT': {
      const data = quantized.data as Buffer;
      data.copy(buf, offset);
      return offset + data.length;
    }
    default:
      return offset;
  }
}

function readQuantizedDataInternal(buf: Buffer, offset: number, quantization: string, dimensions: number): { quantized: QuantizedVector; offset: number } {
  switch (quantization) {
    case 'F32': {
      const data = new Float64Array(dimensions);
      for (let i = 0; i < dimensions; i++) {
        data[i] = buf.readDoubleLE(offset);
        offset += 8;
      }
      return { quantized: { data }, offset };
    }
    case 'INT8': {
      const min = buf.readDoubleLE(offset); offset += 8;
      const max = buf.readDoubleLE(offset); offset += 8;
      const data = new Int8Array(dimensions);
      for (let i = 0; i < dimensions; i++) {
        data[i] = buf.readInt8(offset);
        offset += 1;
      }
      return { quantized: { data, min, max }, offset };
    }
    case 'BIT': {
      const byteCount = Math.ceil(dimensions / 8);
      const data = Buffer.alloc(byteCount);
      buf.copy(data, 0, offset, offset + byteCount);
      return { quantized: { data, dimensions }, offset: offset + byteCount };
    }
    default:
      return { quantized: { data: new Float64Array(0) }, offset };
  }
}
