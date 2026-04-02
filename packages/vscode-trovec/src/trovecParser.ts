import { brotliDecompressSync } from 'node:zlib';

// Binary format (mirrored from @trovec/core serialization.ts):
// Header (16 bytes):
//   [0..3]   magic: "VCR\x01"
//   [4]      version: 1
//   [5..8]   dimensions: uint32 LE
//   [9]      quantization enum: 0=F32, 1=INT8, 2=BIT
//   [10]     metric enum: 0=cosine, 1=euclidean, 2=dot, 3=hamming
//   [11..14] entry count: uint32 LE
//   [15]     reserved

export type QuantizationType = 'F32' | 'INT8' | 'BIT';
export type MetricType = 'cosine' | 'euclidean' | 'dot' | 'hamming';

export interface TrovecHeader {
  dimensions: number;
  quantization: QuantizationType;
  metric: MetricType;
  entryCount: number;
}

export interface TrovecEntry {
  id: string;
  embedding: number[];
  context?: Record<string, unknown>;
}

export interface ParsedTrovec {
  header: TrovecHeader;
  entries: TrovecEntry[];
}

const MAGIC = Buffer.from('VCR\x01');
const HEADER_SIZE = 16;
const QUANT_REVERSE: QuantizationType[] = ['F32', 'INT8', 'BIT'];
const METRIC_REVERSE: MetricType[] = ['cosine', 'euclidean', 'dot', 'hamming'];

function tryDecompress(raw: Buffer): Buffer {
  try {
    return brotliDecompressSync(raw);
  } catch {
    return raw;
  }
}

function readHeader(buf: Buffer): TrovecHeader {
  if (buf.length < HEADER_SIZE) {
    throw new Error('Buffer too small for header');
  }

  const magic = buf.subarray(0, 4);
  if (!magic.equals(MAGIC)) {
    throw new Error('Invalid magic bytes — not a .trovec file');
  }

  const version = buf.readUInt8(4);
  if (version !== 1) {
    throw new Error(`Unsupported version: ${version}`);
  }

  return {
    dimensions: buf.readUInt32LE(5),
    quantization: QUANT_REVERSE[buf.readUInt8(9)],
    metric: METRIC_REVERSE[buf.readUInt8(10)],
    entryCount: buf.readUInt32LE(11),
  };
}

function decodeF32(buf: Buffer, offset: number, dimensions: number): { embedding: number[]; offset: number } {
  const embedding: number[] = new Array(dimensions);
  for (let i = 0; i < dimensions; i++) {
    embedding[i] = buf.readDoubleLE(offset);
    offset += 8;
  }
  return { embedding, offset };
}

function decodeINT8(buf: Buffer, offset: number, dimensions: number): { embedding: number[]; offset: number } {
  const min = buf.readDoubleLE(offset);
  offset += 8;
  const max = buf.readDoubleLE(offset);
  offset += 8;
  const range = max - min;
  const embedding: number[] = new Array(dimensions);
  for (let i = 0; i < dimensions; i++) {
    const val = buf.readInt8(offset);
    offset += 1;
    // Reconstruct approximate float from INT8 quantization
    embedding[i] = range === 0 ? min : min + ((val + 128) / 255) * range;
  }
  return { embedding, offset };
}

function decodeBIT(buf: Buffer, offset: number, dimensions: number): { embedding: number[]; offset: number } {
  const byteCount = Math.ceil(dimensions / 8);
  const embedding: number[] = new Array(dimensions);
  for (let i = 0; i < dimensions; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = 7 - (i % 8); // MSB-first
    embedding[i] = (buf[offset + byteIdx] >> bitIdx) & 1;
  }
  return { embedding, offset: offset + byteCount };
}

export function parse(raw: Buffer): ParsedTrovec {
  const buf = tryDecompress(raw);
  const header = readHeader(buf);
  const { dimensions, quantization, entryCount } = header;

  const entries: TrovecEntry[] = [];
  let offset = HEADER_SIZE;

  for (let i = 0; i < entryCount; i++) {
    // Read ID
    const idType = buf.readUInt8(offset);
    offset += 1;
    const idLen = buf.readUInt32LE(offset);
    offset += 4;
    const idStr = buf.toString('utf-8', offset, offset + idLen);
    offset += idLen;

    const id = idType === 1 ? `bigint:${idStr}` : idStr;

    // Read embedding
    let embedding: number[];
    let result: { embedding: number[]; offset: number };

    switch (quantization) {
      case 'F32':
        result = decodeF32(buf, offset, dimensions);
        break;
      case 'INT8':
        result = decodeINT8(buf, offset, dimensions);
        break;
      case 'BIT':
        result = decodeBIT(buf, offset, dimensions);
        break;
    }
    embedding = result.embedding;
    offset = result.offset;

    // Read context
    const contextLen = buf.readUInt32LE(offset);
    offset += 4;
    let context: Record<string, unknown> | undefined;
    if (contextLen > 0) {
      const contextStr = buf.toString('utf-8', offset, offset + contextLen);
      context = JSON.parse(contextStr) as Record<string, unknown>;
      offset += contextLen;
    }

    entries.push({ id, embedding, context });
  }

  return { header, entries };
}
