import { createDecipheriv, pbkdf2Sync } from 'node:crypto';

// Must match the constants in @trovec/core storage/encryption.ts
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const HEADER_SIZE = 1 + 1 + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH; // 46 bytes
const FORMAT_VERSION = 1;
const KEY_MODE_RAW = 0;
const KEY_MODE_PASSWORD = 1;
const DEFAULT_ITERATIONS = 100_000;
const KEY_LENGTH = 32;

const TROVEC_MAGIC = Buffer.from('VCR\x01');

export type KeyMode = 'password' | 'raw';

export interface EncryptionInfo {
  encrypted: true;
  mode: KeyMode;
}

export interface ResolvedKey {
  mode: typeof KEY_MODE_RAW | typeof KEY_MODE_PASSWORD;
  key?: Buffer;
  password?: string;
  iterations: number;
}

/**
 * Detect whether a raw .trovec file buffer is encrypted.
 *
 * Unencrypted files start with the magic bytes "VCR\x01" (possibly after
 * Brotli compression, but Brotli's first byte is never 0x01 with sub-byte
 * 0x00/0x01, so we can distinguish reliably).
 *
 * Encrypted files start with [FORMAT_VERSION=0x01, KEY_MODE, ...].
 * We disambiguate from a corrupt/unknown file by checking header length.
 */
export function detectEncryption(raw: Buffer): EncryptionInfo | null {
  // Unencrypted (plain or Brotli-compressed): magic bytes present after
  // optional decompression.  The raw on-disk bytes for an unencrypted file
  // are either Brotli-compressed (first byte is typically 0x1b for Brotli
  // stream header) or start with "VCR\x01".
  if (raw.length >= 4 && raw.subarray(0, 4).equals(TROVEC_MAGIC)) {
    return null; // plaintext, uncompressed
  }

  // Brotli-compressed data never starts with 0x01 0x00 or 0x01 0x01.
  // Encrypted data always starts with FORMAT_VERSION (0x01) followed by
  // KEY_MODE (0x00 or 0x01).
  if (
    raw.length >= HEADER_SIZE &&
    raw[0] === FORMAT_VERSION &&
    (raw[1] === KEY_MODE_RAW || raw[1] === KEY_MODE_PASSWORD)
  ) {
    return {
      encrypted: true,
      mode: raw[1] === KEY_MODE_PASSWORD ? 'password' : 'raw',
    };
  }

  // Neither encrypted nor recognisable — let the parser handle the error.
  return null;
}

/**
 * Build a resolved key from a password string.
 */
export function resolvePassword(password: string): ResolvedKey {
  return { mode: KEY_MODE_PASSWORD, password, iterations: DEFAULT_ITERATIONS };
}

/**
 * Build a resolved key from a raw 32-byte key (provided as hex string).
 */
export function resolveRawKey(hexKey: string): ResolvedKey {
  const key = Buffer.from(hexKey, 'hex');
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Key must be exactly ${KEY_LENGTH} bytes (64 hex characters), got ${key.length}`);
  }
  return { mode: KEY_MODE_RAW, key, iterations: 0 };
}

function deriveKey(password: string, salt: Buffer, iterations: number): Buffer {
  return pbkdf2Sync(password, salt, iterations, KEY_LENGTH, 'sha256');
}

/**
 * Decrypt a buffer encrypted by @trovec/core's encryptBuffer.
 * @throws {Error} If the buffer is malformed or decryption fails.
 */
export function decryptBuffer(encrypted: Buffer, resolved: ResolvedKey): Buffer {
  if (encrypted.length < HEADER_SIZE) {
    throw new Error('Encrypted data is too short or has an invalid format');
  }

  let offset = 0;
  const version = encrypted.readUInt8(offset); offset += 1;
  if (version !== FORMAT_VERSION) {
    throw new Error(`Unsupported encryption format version: ${version}`);
  }

  const mode = encrypted.readUInt8(offset); offset += 1;
  const salt = encrypted.subarray(offset, offset + SALT_LENGTH); offset += SALT_LENGTH;
  const iv = encrypted.subarray(offset, offset + IV_LENGTH); offset += IV_LENGTH;
  const authTag = encrypted.subarray(offset, offset + AUTH_TAG_LENGTH); offset += AUTH_TAG_LENGTH;
  const ciphertext = encrypted.subarray(offset);

  let key: Buffer;
  if (mode === KEY_MODE_PASSWORD) {
    if (resolved.mode !== KEY_MODE_PASSWORD) {
      throw new Error('This file was encrypted with a password, but a raw key was provided');
    }
    key = deriveKey(resolved.password!, salt, resolved.iterations);
  } else {
    if (resolved.mode !== KEY_MODE_RAW) {
      throw new Error('This file was encrypted with a raw key, but a password was provided');
    }
    key = resolved.key!;
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('Decryption failed — wrong password or corrupted data');
  }
}
