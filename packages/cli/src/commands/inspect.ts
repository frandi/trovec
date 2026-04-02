import { readFileSync, statSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { formatOutput, detectFormat } from '../output.js';
import { CliError } from '../errors.js';
import { MAGIC, parseHeader } from '../trovec-header.js';
import type { CliFlags } from '../config.js';

export async function inspectCommand(positionals: string[], flags: CliFlags): Promise<void> {
  const filePath = positionals[0];
  if (!filePath) {
    throw new CliError('File path is required.', 'Usage: trovec inspect <file.trovec>');
  }

  let raw: Buffer;
  try {
    raw = readFileSync(filePath);
  } catch {
    throw new CliError(`Cannot read file: ${filePath}`);
  }

  // Try brotli decompression, fall back to raw
  let data: Buffer;
  try {
    data = brotliDecompressSync(raw);
  } catch {
    data = raw;
  }

  if (data.length < 16) {
    throw new CliError('File too small to be a valid .trovec file.');
  }

  // Validate magic bytes
  if (!data.subarray(0, 4).equals(MAGIC)) {
    throw new CliError('Invalid .trovec file (bad magic bytes).');
  }

  const header = parseHeader(data);
  const fileSize = statSync(filePath).size;

  const format = detectFormat(flags.format as string | undefined);

  if (flags.header) {
    process.stdout.write(formatOutput(header as unknown as Record<string, unknown>, format) + '\n');
    return;
  }

  const info: Record<string, unknown> = {
    file: filePath,
    ...header,
    fileSize: formatSize(fileSize),
    rawSize: formatSize(data.length),
    compressed: data.length !== fileSize,
  };

  process.stdout.write(formatOutput(info, format) + '\n');
}


function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
