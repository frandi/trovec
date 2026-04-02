import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';

export const MAGIC = Buffer.from('VCR\x01');
export const QUANTIZATION_NAMES = ['F32', 'INT8', 'BIT'] as const;
export const METRIC_NAMES = ['cosine', 'euclidean', 'dot', 'hamming'] as const;

export interface TrovecHeader {
  dimensions: number;
  quantization: string;
  metric: string;
  entryCount: number;
}

export function parseHeader(data: Buffer): TrovecHeader {
  const dimensions = data.readUInt32LE(5);
  const quantizationIdx = data[9];
  const metricIdx = data[10];
  const entryCount = data.readUInt32LE(11);

  return {
    dimensions,
    quantization: QUANTIZATION_NAMES[quantizationIdx] ?? `unknown(${quantizationIdx})`,
    metric: METRIC_NAMES[metricIdx] ?? `unknown(${metricIdx})`,
    entryCount,
  };
}

/**
 * Read the header from the first .trovec file found in a directory.
 * Returns null if no valid .trovec file is found.
 */
export function readHeaderFromDir(dir: string): TrovecHeader | null {
  let entries: string[];
  try {
    entries = readdirSync(resolve(dir)).filter(f => f.endsWith('.trovec'));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;

  let raw: Buffer;
  try {
    raw = readFileSync(join(resolve(dir), entries[0]));
  } catch {
    return null;
  }

  // Try brotli decompression, fall back to raw
  let data: Buffer;
  try {
    data = brotliDecompressSync(raw);
  } catch {
    data = raw;
  }

  if (data.length < 16 || !data.subarray(0, 4).equals(MAGIC)) {
    return null;
  }

  return parseHeader(data);
}
