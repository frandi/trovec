import { readFileSync, statSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { formatOutput, detectFormat } from '../output.js';
import { mergeConfig } from '../config.js';
import { resolveEncryptionFlags } from '../db-manager.js';
import { CliError } from '../errors.js';
import { MAGIC, parseHeader } from '../trovec-header.js';
import type { CliFlags } from '../config.js';

/** Check if raw data looks like an encrypted trovec file (encryption header format v1). */
function looksEncrypted(data: Buffer): boolean {
  // Encrypted format: [0]=version(1), [1]=mode(0 or 1), then salt+iv+tag = 46 byte header
  return data.length >= 46 && data[0] === 1 && (data[1] === 0 || data[1] === 1);
}

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

  // If data doesn't start with magic bytes, it might be encrypted
  let encrypted = false;
  if (data.length >= 4 && !data.subarray(0, 4).equals(MAGIC)) {
    if (looksEncrypted(data)) {
      const merged = mergeConfig(flags);
      const encryptionOpts = resolveEncryptionFlags(merged);

      if (!encryptionOpts) {
        throw new CliError(
          'File appears to be encrypted.',
          'Provide --encryption-key <hex> or --encryption-password <pass> to decrypt.',
        );
      }

      // Decrypt, then try brotli decompression on the plaintext
      const { decryptBuffer, resolveEncryptionKey } = await import('@trovec/core');
      const resolved = resolveEncryptionKey(encryptionOpts);
      const decrypted = decryptBuffer(data, resolved);

      try {
        data = brotliDecompressSync(decrypted);
      } catch {
        data = decrypted;
      }
      encrypted = true;
    }
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
    encrypted,
  };

  process.stdout.write(formatOutput(info, format) + '\n');
}


function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
