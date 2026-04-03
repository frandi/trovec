import { open, readFile, access, unlink } from 'node:fs/promises';
import { crc32 } from './crc32.js';
import type { WalOperation, QuantizationType, QuantizedVector, EntryId } from '../types.js';

// WAL File Header (12 bytes):
//   [0..3]   magic: "WVCR" (4 bytes)
//   [4]      version: 1 (1 byte)
//   [5..8]   dimensions: uint32 LE (4 bytes)
//   [9]      quantization: 0=F32, 1=INT8, 2=BIT (1 byte)
//   [10..11] reserved (2 bytes)
//
// WAL Entry (variable):
//   [0..3]   payload length: uint32 LE (bytes after this field, excluding CRC)
//   [4..7]   sequence number: uint32 LE
//   [8]      operation: 0=put, 1=delete
//   [9]      id type: 0=string, 1=bigint
//   [10..13] id length: uint32 LE
//   [14..N]  id data: UTF-8
//   -- For put only:
//     quantized vector data (same encoding as serialization.ts)
//     [4 bytes] context JSON length: uint32 LE
//     [N bytes] context JSON: UTF-8
//   [last 4 bytes] CRC32 of payload (from sequence number through content end)

const WAL_MAGIC = Buffer.from('WVCR');
const WAL_VERSION = 1;
const WAL_HEADER_SIZE = 12;

const QUANT_MAP: Record<QuantizationType, number> = { F32: 0, INT8: 1, BIT: 2 };
const QUANT_REVERSE: QuantizationType[] = ['F32', 'INT8', 'BIT'];

export interface WalConfig {
  dimensions: number;
  quantization: QuantizationType;
}

export interface WalEntry {
  sequence: number;
  op: WalOperation;
}

function quantizedDataSize(quantization: QuantizationType, dimensions: number): number {
  switch (quantization) {
    case 'F32': return dimensions * 8;
    case 'INT8': return 16 + dimensions;
    case 'BIT': return Math.ceil(dimensions / 8);
  }
}

function writeQuantizedData(buf: Buffer, offset: number, quantized: QuantizedVector, quantization: QuantizationType): number {
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
  }
}

function readQuantizedData(buf: Buffer, offset: number, quantization: QuantizationType, dimensions: number): { quantized: QuantizedVector; offset: number } {
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
  }
}

function serializeWalEntry(op: WalOperation, sequence: number, config: WalConfig): Buffer {
  const idStr = typeof op.id === 'bigint' ? op.id.toString() : (op.id as string);
  const idBuf = Buffer.from(idStr, 'utf-8');
  const idType = typeof op.id === 'bigint' ? 1 : 0;

  // Calculate payload size (everything between payloadLength and CRC)
  let payloadSize = 4 + 1 + 1 + 4 + idBuf.length; // seq + op + idType + idLen + idData

  let contextBuf: Buffer | null = null;
  if (op.type === 'put') {
    payloadSize += quantizedDataSize(config.quantization, config.dimensions);
    contextBuf = op.context ? Buffer.from(JSON.stringify(op.context), 'utf-8') : null;
    payloadSize += 4 + (contextBuf ? contextBuf.length : 0);
  }

  // Total: 4 (payloadLen) + payload + 4 (CRC)
  const buf = Buffer.alloc(4 + payloadSize + 4);
  let offset = 0;

  buf.writeUInt32LE(payloadSize, offset); offset += 4;

  const payloadStart = offset;
  buf.writeUInt32LE(sequence, offset); offset += 4;
  buf.writeUInt8(op.type === 'put' ? 0 : 1, offset); offset += 1;
  buf.writeUInt8(idType, offset); offset += 1;
  buf.writeUInt32LE(idBuf.length, offset); offset += 4;
  idBuf.copy(buf, offset); offset += idBuf.length;

  if (op.type === 'put') {
    offset = writeQuantizedData(buf, offset, op.quantized, config.quantization);
    const contextLen = contextBuf ? contextBuf.length : 0;
    buf.writeUInt32LE(contextLen, offset); offset += 4;
    if (contextBuf) {
      contextBuf.copy(buf, offset); offset += contextBuf.length;
    }
  }

  const payloadEnd = offset;
  const checksum = crc32(buf.subarray(payloadStart, payloadEnd));
  buf.writeUInt32LE(checksum, offset);

  return buf;
}

function createWalHeader(config: WalConfig): Buffer {
  const buf = Buffer.alloc(WAL_HEADER_SIZE);
  WAL_MAGIC.copy(buf, 0);
  buf.writeUInt8(WAL_VERSION, 4);
  buf.writeUInt32LE(config.dimensions, 5);
  buf.writeUInt8(QUANT_MAP[config.quantization], 9);
  // bytes 10-11 reserved
  return buf;
}

export async function appendWalEntries(
  walPath: string,
  ops: WalOperation[],
  sequenceStart: number,
  config: WalConfig,
): Promise<number> {
  if (ops.length === 0) return sequenceStart;

  // Check if WAL file exists; if not, write header first
  let needsHeader = false;
  try {
    await access(walPath);
  } catch {
    needsHeader = true;
  }

  const fd = await open(walPath, 'a');
  try {
    if (needsHeader) {
      const header = createWalHeader(config);
      await fd.writeFile(header);
    }

    let seq = sequenceStart;
    for (const op of ops) {
      const entry = serializeWalEntry(op, seq, config);
      await fd.writeFile(entry);
      seq++;
    }
    return seq;
  } finally {
    await fd.close();
  }
}

export interface ReadWalResult {
  entries: WalEntry[];
  nextSequence: number;
  truncated: boolean;
}

export async function readWalEntries(walPath: string, config: WalConfig): Promise<ReadWalResult> {
  let raw: Buffer;
  try {
    raw = await readFile(walPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { entries: [], nextSequence: 0, truncated: false };
    }
    throw err;
  }

  if (raw.length < WAL_HEADER_SIZE) {
    return { entries: [], nextSequence: 0, truncated: true };
  }

  // Validate header
  const magic = raw.subarray(0, 4);
  if (!magic.equals(WAL_MAGIC)) {
    return { entries: [], nextSequence: 0, truncated: true };
  }
  const version = raw.readUInt8(4);
  if (version !== WAL_VERSION) {
    return { entries: [], nextSequence: 0, truncated: true };
  }
  const fileDims = raw.readUInt32LE(5);
  const fileQuant = QUANT_REVERSE[raw.readUInt8(9)];
  if (fileDims !== config.dimensions || fileQuant !== config.quantization) {
    return { entries: [], nextSequence: 0, truncated: true };
  }

  const entries: WalEntry[] = [];
  let offset = WAL_HEADER_SIZE;
  let truncated = false;

  while (offset < raw.length) {
    // Need at least 4 bytes for payload length
    if (offset + 4 > raw.length) { truncated = true; break; }

    const payloadLen = raw.readUInt32LE(offset); offset += 4;

    // Need payload + 4 bytes CRC
    if (offset + payloadLen + 4 > raw.length) { truncated = true; break; }

    const payloadStart = offset;
    const payloadEnd = offset + payloadLen;

    // Validate CRC
    const storedCrc = raw.readUInt32LE(payloadEnd);
    const computedCrc = crc32(raw.subarray(payloadStart, payloadEnd));
    if (storedCrc !== computedCrc) { truncated = true; break; }

    // Parse entry
    const sequence = raw.readUInt32LE(offset); offset += 4;
    const opType = raw.readUInt8(offset); offset += 1;
    const idType = raw.readUInt8(offset); offset += 1;
    const idLen = raw.readUInt32LE(offset); offset += 4;
    const idStr = raw.toString('utf-8', offset, offset + idLen); offset += idLen;

    const id: EntryId = idType === 1 ? BigInt(idStr) : idStr;

    let op: WalOperation;
    if (opType === 0) {
      // PUT
      const { quantized, offset: newOffset } = readQuantizedData(raw, offset, config.quantization, config.dimensions);
      offset = newOffset;
      const contextLen = raw.readUInt32LE(offset); offset += 4;
      let context: Record<string, unknown> | undefined;
      if (contextLen > 0) {
        const contextStr = raw.toString('utf-8', offset, offset + contextLen);
        context = JSON.parse(contextStr) as Record<string, unknown>;
        offset += contextLen;
      }
      op = { type: 'put', id, quantized, context };
    } else {
      // DELETE
      op = { type: 'delete', id };
    }

    entries.push({ sequence, op });

    // Skip past CRC
    offset = payloadEnd + 4;
  }

  const nextSequence = entries.length > 0 ? entries[entries.length - 1].sequence + 1 : 0;
  return { entries, nextSequence, truncated };
}

export function replayWal(
  entries: WalEntry[],
  baseEntries: Map<string, { id: EntryId; quantized: QuantizedVector; context?: Record<string, unknown> }>,
): void {
  for (const { op } of entries) {
    const key = typeof op.id === 'bigint' ? `__bigint__:${op.id.toString()}` : (op.id as string);
    if (op.type === 'put') {
      baseEntries.set(key, { id: op.id, quantized: op.quantized, context: op.context });
    } else {
      baseEntries.delete(key);
    }
  }
}

export async function deleteWal(walPath: string): Promise<void> {
  try {
    await unlink(walPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}
