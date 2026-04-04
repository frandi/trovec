import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from 'node:crypto';
import type { StorageDriver, EncryptionOptions } from '../types.js';
import { EncryptionError } from '../errors.js';

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

export interface ResolvedEncryption {
  mode: typeof KEY_MODE_RAW | typeof KEY_MODE_PASSWORD;
  key?: Buffer;
  password?: string;
  iterations: number;
}

/**
 * Validate encryption options and resolve the key mode.
 * @throws {EncryptionError} If options are invalid.
 */
export function resolveEncryptionKey(options: EncryptionOptions): ResolvedEncryption {
  const hasKey = options.key != null;
  const hasPassword = options.password != null;

  if (!hasKey && !hasPassword) {
    throw new EncryptionError('Exactly one of "key" or "password" must be provided');
  }
  if (hasKey && hasPassword) {
    throw new EncryptionError('Exactly one of "key" or "password" must be provided');
  }

  if (hasKey) {
    if (options.key!.length !== KEY_LENGTH) {
      throw new EncryptionError(`Encryption key must be exactly ${KEY_LENGTH} bytes (256 bits), got ${options.key!.length}`);
    }
    return { mode: KEY_MODE_RAW, key: options.key!, iterations: 0 };
  }

  if (typeof options.password !== 'string' || options.password.length === 0) {
    throw new EncryptionError('Password must be a non-empty string');
  }

  return {
    mode: KEY_MODE_PASSWORD,
    password: options.password,
    iterations: options.iterations ?? DEFAULT_ITERATIONS,
  };
}

function deriveKey(password: string, salt: Buffer, iterations: number): Buffer {
  return pbkdf2Sync(password, salt, iterations, KEY_LENGTH, 'sha256');
}

/**
 * Encrypt a plaintext buffer using AES-256-GCM.
 *
 * Output format (46-byte header + ciphertext):
 *   [0]       format version (1)
 *   [1]       key mode: 0=raw, 1=password
 *   [2..17]   salt (16 bytes, zeros for raw key mode)
 *   [18..29]  IV (12 bytes, random)
 *   [30..45]  auth tag (16 bytes)
 *   [46..N]   ciphertext
 */
export function encryptBuffer(plaintext: Buffer, resolved: ResolvedEncryption): Buffer {
  const iv = randomBytes(IV_LENGTH);
  let key: Buffer;
  let salt: Buffer;

  if (resolved.mode === KEY_MODE_RAW) {
    key = resolved.key!;
    salt = Buffer.alloc(SALT_LENGTH);
  } else {
    salt = randomBytes(SALT_LENGTH);
    key = deriveKey(resolved.password!, salt, resolved.iterations);
  }

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const output = Buffer.alloc(HEADER_SIZE + encrypted.length);
  let offset = 0;

  output.writeUInt8(FORMAT_VERSION, offset); offset += 1;
  output.writeUInt8(resolved.mode, offset); offset += 1;
  salt.copy(output, offset); offset += SALT_LENGTH;
  iv.copy(output, offset); offset += IV_LENGTH;
  authTag.copy(output, offset); offset += AUTH_TAG_LENGTH;
  encrypted.copy(output, offset);

  return output;
}

/**
 * Decrypt a buffer encrypted by {@link encryptBuffer}.
 * @throws {EncryptionError} If the buffer is malformed or decryption fails.
 */
export function decryptBuffer(encrypted: Buffer, resolved: ResolvedEncryption): Buffer {
  if (encrypted.length < HEADER_SIZE) {
    throw new EncryptionError('Encrypted data is too short or has an invalid format');
  }

  let offset = 0;
  const version = encrypted.readUInt8(offset); offset += 1;
  if (version !== FORMAT_VERSION) {
    throw new EncryptionError(`Unsupported encryption format version: ${version}`);
  }

  const mode = encrypted.readUInt8(offset); offset += 1;
  const salt = encrypted.subarray(offset, offset + SALT_LENGTH); offset += SALT_LENGTH;
  const iv = encrypted.subarray(offset, offset + IV_LENGTH); offset += IV_LENGTH;
  const authTag = encrypted.subarray(offset, offset + AUTH_TAG_LENGTH); offset += AUTH_TAG_LENGTH;
  const ciphertext = encrypted.subarray(offset);

  let key: Buffer;
  if (mode === KEY_MODE_PASSWORD) {
    if (resolved.mode !== KEY_MODE_PASSWORD) {
      throw new EncryptionError('Decryption failed: data was encrypted with a password but a raw key was provided');
    }
    key = deriveKey(resolved.password!, salt, resolved.iterations);
  } else {
    if (resolved.mode !== KEY_MODE_RAW) {
      throw new EncryptionError('Decryption failed: data was encrypted with a raw key but a password was provided');
    }
    key = resolved.key!;
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new EncryptionError('Decryption failed: wrong key or corrupted data');
  }
}

/**
 * Add transparent AES-256-GCM encryption to any storage driver.
 *
 * If the driver implements {@link StorageDriver.configureEncryption | configureEncryption},
 * encryption is delegated to the driver itself (preserving internal concerns like
 * compress-then-encrypt ordering and WAL encryption). The original driver is returned
 * as-is so that its full interface (e.g. {@link WalAwareDriver}) is preserved.
 *
 * Otherwise, a thin wrapper is returned that encrypts on `write()` and decrypts on
 * `read()`. This is the path community / custom drivers take — they get encryption
 * for free without implementing it themselves.
 *
 * @param innerDriver - The storage driver to encrypt.
 * @param options - Encryption configuration (raw key or password).
 * @returns The driver with encryption enabled.
 * @throws {EncryptionError} If encryption options are invalid.
 *
 * @example
 * ```ts
 * import { createFileDriver, withEncryption } from '@trovec/core';
 *
 * const driver = withEncryption(createFileDriver(), {
 *   key: Buffer.from('0123456789abcdef0123456789abcdef'), // 32 bytes
 * });
 * ```
 */
export function withEncryption<T extends StorageDriver>(innerDriver: T, options: EncryptionOptions): T {
  // Validate options eagerly regardless of path
  resolveEncryptionKey(options);

  // Built-in drivers handle encryption internally (correct ordering, WAL support)
  if (innerDriver.configureEncryption) {
    innerDriver.configureEncryption(options);
    return innerDriver;
  }

  // Fallback wrapper for community / custom drivers
  const resolved = resolveEncryptionKey(options);

  return {
    ...innerDriver,

    async write(collectionId: string, data: Buffer): Promise<void> {
      const encrypted = encryptBuffer(data, resolved);
      await innerDriver.write(collectionId, encrypted);
    },

    async read(collectionId: string): Promise<Buffer | null> {
      const encrypted = await innerDriver.read(collectionId);
      if (encrypted === null) return null;
      return decryptBuffer(encrypted, resolved);
    },

    async exists(collectionId: string): Promise<boolean> {
      return innerDriver.exists(collectionId);
    },

    async delete(collectionId: string): Promise<boolean> {
      return innerDriver.delete(collectionId);
    },
  };
}
