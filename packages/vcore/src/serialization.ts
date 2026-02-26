import type { VCoreInstance, QuantizationType, MetricType, EntryId, QuantizedVector } from './types.js';

// Binary format:
// Header (16 bytes):
//   [0..3]   magic: "VCR\x01" (4 bytes)
//   [4]      version: 1 (1 byte)
//   [5..8]   dimensions: uint32 LE (4 bytes)
//   [9]      quantization enum: 0=F32, 1=INT8, 2=BIT (1 byte)
//   [10]     metric enum: 0=cosine, 1=euclidean, 2=dot, 3=hamming (1 byte)
//   [11..14] entry count: uint32 LE (4 bytes)
//   [15]     reserved (1 byte)
//
// Per entry:
//   [0]      id type: 0=string, 1=bigint (1 byte)
//   [1..4]   id data length: uint32 LE (4 bytes)
//   [5..N]   id data: UTF-8 string or bigint decimal string
//   Quantized data (format depends on quantization type):
//     F32: dimensions * 8 bytes (Float64 LE values)
//     INT8: 8 bytes (min Float64 LE) + 8 bytes (max Float64 LE) + dimensions bytes (Int8 values)
//     BIT: ceil(dimensions / 8) bytes (packed bits)
//   [4 bytes] context JSON length: uint32 LE (0 if no context)
//   [N bytes] context JSON: UTF-8

const MAGIC = Buffer.from('VCR\x01');
const VERSION = 1;
const HEADER_SIZE = 16;

const QUANT_MAP: Record<QuantizationType, number> = { F32: 0, INT8: 1, BIT: 2 };
const QUANT_REVERSE: QuantizationType[] = ['F32', 'INT8', 'BIT'];

const METRIC_MAP: Record<MetricType, number> = { cosine: 0, euclidean: 1, dot: 2, hamming: 3 };

function quantizedDataSize(quantization: QuantizationType, dimensions: number): number {
  switch (quantization) {
    case 'F32': return dimensions * 8;
    case 'INT8': return 16 + dimensions; // 8 (min) + 8 (max) + dimensions
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
      buf.writeDoubleLE(quantized.min!, offset);
      offset += 8;
      buf.writeDoubleLE(quantized.max!, offset);
      offset += 8;
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
      const min = buf.readDoubleLE(offset);
      offset += 8;
      const max = buf.readDoubleLE(offset);
      offset += 8;
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

export function serialize(instance: VCoreInstance): Buffer {
  const { dimensions, quantization, metric } = instance.config;
  const entries = Array.from(instance.entries.values());

  // Calculate total buffer size
  let totalSize = HEADER_SIZE;

  const entryBuffers: { idType: number; idBuf: Buffer; quantized: QuantizedVector; contextBuf: Buffer | null }[] = [];

  for (const entry of entries) {
    const idType = typeof entry.id === 'bigint' ? 1 : 0;
    const idStr = typeof entry.id === 'bigint' ? entry.id.toString() : entry.id;
    const idBuf = Buffer.from(idStr, 'utf-8');
    const contextBuf = entry.context ? Buffer.from(JSON.stringify(entry.context), 'utf-8') : null;

    totalSize += 1 + 4 + idBuf.length; // id type + id length + id data
    totalSize += quantizedDataSize(quantization, dimensions);
    totalSize += 4 + (contextBuf ? contextBuf.length : 0); // context length + context data

    entryBuffers.push({ idType, idBuf, quantized: entry.quantized, contextBuf });
  }

  const buf = Buffer.alloc(totalSize);
  let offset = 0;

  // Write header
  MAGIC.copy(buf, offset); offset += 4;
  buf.writeUInt8(VERSION, offset); offset += 1;
  buf.writeUInt32LE(dimensions, offset); offset += 4;
  buf.writeUInt8(QUANT_MAP[quantization], offset); offset += 1;
  buf.writeUInt8(METRIC_MAP[metric], offset); offset += 1;
  buf.writeUInt32LE(entries.length, offset); offset += 4;
  buf.writeUInt8(0, offset); offset += 1; // reserved

  // Write entries
  for (const { idType, idBuf, quantized, contextBuf } of entryBuffers) {
    buf.writeUInt8(idType, offset); offset += 1;
    buf.writeUInt32LE(idBuf.length, offset); offset += 4;
    idBuf.copy(buf, offset); offset += idBuf.length;

    offset = writeQuantizedData(buf, offset, quantized, quantization);

    const contextLen = contextBuf ? contextBuf.length : 0;
    buf.writeUInt32LE(contextLen, offset); offset += 4;
    if (contextBuf) {
      contextBuf.copy(buf, offset); offset += contextBuf.length;
    }
  }

  return buf;
}

export function deserialize(buffer: Buffer, instance: VCoreInstance): void {
  const { dimensions, quantization } = instance.config;

  // Read and validate header
  if (buffer.length < HEADER_SIZE) {
    throw new Error('Buffer too small for header');
  }

  const magic = buffer.subarray(0, 4);
  if (!magic.equals(MAGIC)) {
    throw new Error('Invalid magic bytes');
  }

  const version = buffer.readUInt8(4);
  if (version !== VERSION) {
    throw new Error(`Unsupported version: ${version}`);
  }

  const fileDimensions = buffer.readUInt32LE(5);
  if (fileDimensions !== dimensions) {
    throw new Error(`Dimension mismatch: file has ${fileDimensions}, instance expects ${dimensions}`);
  }

  const fileQuant = QUANT_REVERSE[buffer.readUInt8(9)];
  if (fileQuant !== quantization) {
    throw new Error(`Quantization mismatch: file has ${fileQuant}, instance expects ${quantization}`);
  }

  // Read metric byte (informational, not validated)
  buffer.readUInt8(10);

  const entryCount = buffer.readUInt32LE(11);
  // byte 15 is reserved

  let offset = HEADER_SIZE;

  instance.entries.clear();

  for (let i = 0; i < entryCount; i++) {
    const idType = buffer.readUInt8(offset); offset += 1;
    const idLen = buffer.readUInt32LE(offset); offset += 4;
    const idStr = buffer.toString('utf-8', offset, offset + idLen); offset += idLen;

    const id: EntryId = idType === 1 ? BigInt(idStr) : idStr;

    const { quantized, offset: newOffset } = readQuantizedData(buffer, offset, quantization, dimensions);
    offset = newOffset;

    const contextLen = buffer.readUInt32LE(offset); offset += 4;
    let context: Record<string, unknown> | undefined;
    if (contextLen > 0) {
      const contextStr = buffer.toString('utf-8', offset, offset + contextLen);
      context = JSON.parse(contextStr) as Record<string, unknown>;
      offset += contextLen;
    }

    const key = typeof id === 'bigint' ? `__bigint__:${id.toString()}` : id;
    instance.entries.set(key, { id, quantized, context });
  }
}
