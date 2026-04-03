import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendWalEntries, readWalEntries, replayWal, deleteWal } from '../../src/storage/wal.js';
import { crc32 } from '../../src/storage/crc32.js';
import type { WalOperation, EntryId, QuantizedVector } from '../../src/types.js';

const config = { dimensions: 3, quantization: 'F32' as const };

function makePutOp(id: string, values: number[], context?: Record<string, unknown>): WalOperation {
  return {
    type: 'put',
    id,
    quantized: { data: new Float64Array(values) },
    context,
  };
}

function makeDeleteOp(id: string): WalOperation {
  return { type: 'delete', id };
}

describe('CRC32', () => {
  it('produces consistent results for same input', () => {
    const data = Buffer.from('hello world');
    expect(crc32(data)).toBe(crc32(data));
  });

  it('produces different results for different inputs', () => {
    const a = crc32(Buffer.from('hello'));
    const b = crc32(Buffer.from('world'));
    expect(a).not.toBe(b);
  });

  it('matches known CRC32 value', () => {
    // CRC32 of empty buffer
    const empty = crc32(Buffer.alloc(0));
    expect(empty).toBe(0x00000000);

    // CRC32 of "123456789" is 0xCBF43926 (IEEE)
    const known = crc32(Buffer.from('123456789'));
    expect(known).toBe(0xCBF43926);
  });
});

describe('WAL', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'trovec-wal-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes and reads back a single entry', async () => {
    const walPath = join(dir, 'test.wal');
    const op = makePutOp('doc-1', [1.0, 2.0, 3.0], { tag: 'hello' });

    await appendWalEntries(walPath, [op], 0, config);
    const result = await readWalEntries(walPath, config);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].sequence).toBe(0);
    expect(result.entries[0].op.type).toBe('put');
    expect(result.entries[0].op.id).toBe('doc-1');
    if (result.entries[0].op.type === 'put') {
      const data = result.entries[0].op.quantized.data as Float64Array;
      expect(Array.from(data)).toEqual([1.0, 2.0, 3.0]);
      expect(result.entries[0].op.context).toEqual({ tag: 'hello' });
    }
    expect(result.nextSequence).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('writes and reads multiple entries', async () => {
    const walPath = join(dir, 'test.wal');
    const ops = [
      makePutOp('a', [1, 0, 0]),
      makePutOp('b', [0, 1, 0]),
      makeDeleteOp('a'),
    ];

    await appendWalEntries(walPath, ops, 0, config);
    const result = await readWalEntries(walPath, config);

    expect(result.entries).toHaveLength(3);
    expect(result.entries[0].sequence).toBe(0);
    expect(result.entries[1].sequence).toBe(1);
    expect(result.entries[2].sequence).toBe(2);
    expect(result.entries[2].op.type).toBe('delete');
    expect(result.nextSequence).toBe(3);
  });

  it('appends to existing WAL', async () => {
    const walPath = join(dir, 'test.wal');

    await appendWalEntries(walPath, [makePutOp('a', [1, 0, 0])], 0, config);
    await appendWalEntries(walPath, [makePutOp('b', [0, 1, 0])], 1, config);

    const result = await readWalEntries(walPath, config);
    expect(result.entries).toHaveLength(2);
    expect(result.nextSequence).toBe(2);
  });

  it('detects corruption and stops at last valid entry', async () => {
    const walPath = join(dir, 'test.wal');

    await appendWalEntries(walPath, [
      makePutOp('a', [1, 0, 0]),
      makePutOp('b', [0, 1, 0]),
    ], 0, config);

    // Corrupt the last few bytes of the file (CRC area)
    const data = await readFile(walPath);
    const corrupted = Buffer.from(data);
    corrupted[corrupted.length - 1] ^= 0xFF;
    await writeFile(walPath, corrupted);

    const result = await readWalEntries(walPath, config);
    expect(result.entries).toHaveLength(1); // only first entry is valid
    expect(result.truncated).toBe(true);
  });

  it('returns empty for non-existent WAL', async () => {
    const walPath = join(dir, 'nonexistent.wal');
    const result = await readWalEntries(walPath, config);
    expect(result.entries).toHaveLength(0);
    expect(result.nextSequence).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('handles put without context', async () => {
    const walPath = join(dir, 'test.wal');
    const op = makePutOp('doc-1', [1.0, 2.0, 3.0]);

    await appendWalEntries(walPath, [op], 0, config);
    const result = await readWalEntries(walPath, config);

    expect(result.entries).toHaveLength(1);
    if (result.entries[0].op.type === 'put') {
      expect(result.entries[0].op.context).toBeUndefined();
    }
  });

  it('handles bigint IDs', async () => {
    const walPath = join(dir, 'test.wal');
    const op: WalOperation = {
      type: 'put',
      id: 12345678901234567890n,
      quantized: { data: new Float64Array([1, 2, 3]) },
    };

    await appendWalEntries(walPath, [op], 0, config);
    const result = await readWalEntries(walPath, config);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].op.id).toBe(12345678901234567890n);
  });

  it('deleteWal is no-op for non-existent file', async () => {
    await expect(deleteWal(join(dir, 'nope.wal'))).resolves.toBeUndefined();
  });
});

describe('replayWal', () => {
  it('applies put operations', () => {
    const entries = new Map<string, { id: EntryId; quantized: QuantizedVector; context?: Record<string, unknown> }>();

    replayWal(
      [
        { sequence: 0, op: makePutOp('a', [1, 0, 0], { tag: 'first' }) },
        { sequence: 1, op: makePutOp('b', [0, 1, 0]) },
      ],
      entries,
    );

    expect(entries.size).toBe(2);
    expect(entries.get('a')?.context).toEqual({ tag: 'first' });
    expect(entries.has('b')).toBe(true);
  });

  it('applies delete operations', () => {
    const entries = new Map<string, { id: EntryId; quantized: QuantizedVector; context?: Record<string, unknown> }>();
    entries.set('a', { id: 'a', quantized: { data: new Float64Array([1, 0, 0]) } });

    replayWal(
      [{ sequence: 0, op: makeDeleteOp('a') }],
      entries,
    );

    expect(entries.size).toBe(0);
  });

  it('put then delete results in empty', () => {
    const entries = new Map<string, { id: EntryId; quantized: QuantizedVector; context?: Record<string, unknown> }>();

    replayWal(
      [
        { sequence: 0, op: makePutOp('a', [1, 0, 0]) },
        { sequence: 1, op: makeDeleteOp('a') },
      ],
      entries,
    );

    expect(entries.size).toBe(0);
  });

  it('overwrites existing entry with same id', () => {
    const entries = new Map<string, { id: EntryId; quantized: QuantizedVector; context?: Record<string, unknown> }>();
    entries.set('a', { id: 'a', quantized: { data: new Float64Array([1, 0, 0]) }, context: { old: true } });

    replayWal(
      [{ sequence: 0, op: makePutOp('a', [0, 0, 1], { new: true }) }],
      entries,
    );

    expect(entries.get('a')?.context).toEqual({ new: true });
  });
});
