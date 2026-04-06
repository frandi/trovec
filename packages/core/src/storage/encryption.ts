import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from 'node:crypto';
import type { StorageDriver, EncryptionOptions } from '../types.js';
import { EncryptionError } from '../errors.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const DEFAULT_ITERATIONS = 100_000;

const KEY_MODE_RAW = 0;
const KEY_MODE_PASSWORD = 1;

// v1 direct encryption header (46 bytes)
const FORMAT_VERSION_V1 = 1;
const V1_HEADER_SIZE = 1 + 1 + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH; // 46

// v2 envelope encryption header (110 bytes)
const FORMAT_VERSION_V2 = 2;
const KEK_VERSION_SIZE = 4;
const ENCRYPTED_DEK_SIZE = KEY_LENGTH; // 32
const AAD_SIZE = 1 + 1 + KEK_VERSION_SIZE; // 6 bytes: version + keyMode + kekVersionId
const V2_HEADER_SIZE =
  1 +                    // [0]       format version
  1 +                    // [1]       key mode
  KEK_VERSION_SIZE +     // [2..5]    KEK version ID
  SALT_LENGTH +          // [6..21]   salt
  IV_LENGTH +            // [22..33]  KEK-IV
  AUTH_TAG_LENGTH +      // [34..49]  KEK-auth-tag
  ENCRYPTED_DEK_SIZE +   // [50..81]  encrypted DEK
  IV_LENGTH +            // [82..93]  data-IV
  AUTH_TAG_LENGTH +      // [94..109] data-auth-tag
  0;                     // [110..N]  ciphertext
// = 110

export { FORMAT_VERSION_V1, FORMAT_VERSION_V2, V1_HEADER_SIZE, V2_HEADER_SIZE };

export interface ResolvedEncryption {
  mode: typeof KEY_MODE_RAW | typeof KEY_MODE_PASSWORD;
  key?: Buffer;
  password?: string;
  iterations: number;
  kekVersionId: number;
  previousKeys?: Array<{
    mode: typeof KEY_MODE_RAW | typeof KEY_MODE_PASSWORD;
    key?: Buffer;
    password?: string;
    iterations: number;
  }>;
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

  const kekVersionId = options.kekVersionId ?? 0;
  if (!Number.isInteger(kekVersionId) || kekVersionId < 0 || kekVersionId > 0xFFFFFFFF) {
    throw new EncryptionError('kekVersionId must be an integer in the range 0–4294967295');
  }

  let resolved: ResolvedEncryption;

  if (hasKey) {
    if (options.key!.length !== KEY_LENGTH) {
      throw new EncryptionError(`Encryption key must be exactly ${KEY_LENGTH} bytes (256 bits), got ${options.key!.length}`);
    }
    resolved = { mode: KEY_MODE_RAW, key: options.key!, iterations: 0, kekVersionId };
  } else {
    if (typeof options.password !== 'string' || options.password.length === 0) {
      throw new EncryptionError('Password must be a non-empty string');
    }
    resolved = {
      mode: KEY_MODE_PASSWORD,
      password: options.password,
      iterations: options.iterations ?? DEFAULT_ITERATIONS,
      kekVersionId,
    };
  }

  // Resolve previous keys for rolling rotation
  if (options.previousKeys && options.previousKeys.length > 0) {
    resolved.previousKeys = options.previousKeys.map((prev) => {
      const prevHasKey = prev.key != null;
      const prevHasPassword = prev.password != null;
      if (!prevHasKey && !prevHasPassword) {
        throw new EncryptionError('Each previousKeys entry must have exactly one of "key" or "password"');
      }
      if (prevHasKey && prevHasPassword) {
        throw new EncryptionError('Each previousKeys entry must have exactly one of "key" or "password"');
      }
      if (prevHasKey) {
        if (prev.key!.length !== KEY_LENGTH) {
          throw new EncryptionError(`Previous key must be exactly ${KEY_LENGTH} bytes, got ${prev.key!.length}`);
        }
        return { mode: KEY_MODE_RAW as typeof KEY_MODE_RAW, key: prev.key!, iterations: 0 };
      }
      if (typeof prev.password !== 'string' || prev.password.length === 0) {
        throw new EncryptionError('Previous password must be a non-empty string');
      }
      return {
        mode: KEY_MODE_PASSWORD as typeof KEY_MODE_PASSWORD,
        password: prev.password,
        iterations: prev.iterations ?? DEFAULT_ITERATIONS,
      };
    });
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function deriveKey(password: string, salt: Buffer, iterations: number): Buffer {
  return pbkdf2Sync(password, salt, iterations, KEY_LENGTH, 'sha256');
}

function resolveKek(
  entry: { mode: number; key?: Buffer; password?: string; iterations: number },
  salt: Buffer,
): Buffer {
  if (entry.mode === KEY_MODE_RAW) return entry.key!;
  return deriveKey(entry.password!, salt, entry.iterations);
}

// ---------------------------------------------------------------------------
// v1 direct encryption (internal — used for WAL entries and backward compat)
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext buffer using v1 direct AES-256-GCM format (46-byte header).
 *
 * Exported for internal use by `concurrent-file.ts` (WAL entry encryption with DEK).
 * Not re-exported from `index.ts`.
 */
export function encryptBufferV1(plaintext: Buffer, resolved: ResolvedEncryption): Buffer {
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

  const output = Buffer.alloc(V1_HEADER_SIZE + encrypted.length);
  let offset = 0;

  output.writeUInt8(FORMAT_VERSION_V1, offset); offset += 1;
  output.writeUInt8(resolved.mode, offset); offset += 1;
  salt.copy(output, offset); offset += SALT_LENGTH;
  iv.copy(output, offset); offset += IV_LENGTH;
  authTag.copy(output, offset); offset += AUTH_TAG_LENGTH;
  encrypted.copy(output, offset);

  return output;
}

function decryptBufferV1(encrypted: Buffer, resolved: ResolvedEncryption): Buffer {
  if (encrypted.length < V1_HEADER_SIZE) {
    throw new EncryptionError('Encrypted data is too short or has an invalid format');
  }

  let offset = 1; // skip version byte (already validated by caller)
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

// ---------------------------------------------------------------------------
// v2 envelope encryption
// ---------------------------------------------------------------------------

function buildAad(mode: number, kekVersionId: number): Buffer {
  const aad = Buffer.alloc(AAD_SIZE);
  aad.writeUInt8(FORMAT_VERSION_V2, 0);
  aad.writeUInt8(mode, 1);
  aad.writeUInt32LE(kekVersionId, 2);
  return aad;
}

function encryptBufferV2(plaintext: Buffer, resolved: ResolvedEncryption): { buffer: Buffer; dek: Buffer } {
  // Generate random DEK
  const dek = randomBytes(KEY_LENGTH);

  // Derive KEK
  let salt: Buffer;
  let kek: Buffer;
  if (resolved.mode === KEY_MODE_RAW) {
    kek = resolved.key!;
    salt = Buffer.alloc(SALT_LENGTH);
  } else {
    salt = randomBytes(SALT_LENGTH);
    kek = deriveKey(resolved.password!, salt, resolved.iterations);
  }

  // Encrypt DEK with KEK (with AAD to prevent header tampering)
  const aad = buildAad(resolved.mode, resolved.kekVersionId);
  const kekIv = randomBytes(IV_LENGTH);
  const kekCipher = createCipheriv(ALGORITHM, kek, kekIv);
  kekCipher.setAAD(aad);
  const encryptedDek = Buffer.concat([kekCipher.update(dek), kekCipher.final()]);
  const kekAuthTag = kekCipher.getAuthTag();

  // Encrypt data with DEK
  const dataIv = randomBytes(IV_LENGTH);
  const dataCipher = createCipheriv(ALGORITHM, dek, dataIv);
  const ciphertext = Buffer.concat([dataCipher.update(plaintext), dataCipher.final()]);
  const dataAuthTag = dataCipher.getAuthTag();

  // Assemble v2 header + ciphertext
  const output = Buffer.alloc(V2_HEADER_SIZE + ciphertext.length);
  let offset = 0;

  output.writeUInt8(FORMAT_VERSION_V2, offset); offset += 1;
  output.writeUInt8(resolved.mode, offset); offset += 1;
  output.writeUInt32LE(resolved.kekVersionId, offset); offset += KEK_VERSION_SIZE;
  salt.copy(output, offset); offset += SALT_LENGTH;
  kekIv.copy(output, offset); offset += IV_LENGTH;
  kekAuthTag.copy(output, offset); offset += AUTH_TAG_LENGTH;
  encryptedDek.copy(output, offset); offset += ENCRYPTED_DEK_SIZE;
  dataIv.copy(output, offset); offset += IV_LENGTH;
  dataAuthTag.copy(output, offset); offset += AUTH_TAG_LENGTH;
  ciphertext.copy(output, offset);

  return { buffer: output, dek };
}

/**
 * Try to unwrap the DEK from a v2 header using the given key entry and salt.
 * Returns the DEK on success, or null if the auth tag doesn't match.
 */
function tryUnwrapDek(
  entry: { mode: number; key?: Buffer; password?: string; iterations: number },
  salt: Buffer,
  kekIv: Buffer,
  kekAuthTag: Buffer,
  encryptedDek: Buffer,
  aad: Buffer,
): Buffer | null {
  const kek = resolveKek(entry, salt);
  try {
    const decipher = createDecipheriv(ALGORITHM, kek, kekIv);
    decipher.setAAD(aad);
    decipher.setAuthTag(kekAuthTag);
    return Buffer.concat([decipher.update(encryptedDek), decipher.final()]);
  } catch {
    return null;
  }
}

interface V2HeaderFields {
  mode: number;
  kekVersionId: number;
  salt: Buffer;
  kekIv: Buffer;
  kekAuthTag: Buffer;
  encryptedDek: Buffer;
  dataIv: Buffer;
  dataAuthTag: Buffer;
  ciphertext: Buffer;
  aad: Buffer;
}

function parseV2Header(encrypted: Buffer): V2HeaderFields {
  if (encrypted.length < V2_HEADER_SIZE) {
    throw new EncryptionError('Encrypted data is too short for v2 envelope format');
  }

  let offset = 1; // skip version byte
  const mode = encrypted.readUInt8(offset); offset += 1;
  const kekVersionId = encrypted.readUInt32LE(offset); offset += KEK_VERSION_SIZE;
  const salt = encrypted.subarray(offset, offset + SALT_LENGTH); offset += SALT_LENGTH;
  const kekIv = encrypted.subarray(offset, offset + IV_LENGTH); offset += IV_LENGTH;
  const kekAuthTag = encrypted.subarray(offset, offset + AUTH_TAG_LENGTH); offset += AUTH_TAG_LENGTH;
  const encryptedDek = encrypted.subarray(offset, offset + ENCRYPTED_DEK_SIZE); offset += ENCRYPTED_DEK_SIZE;
  const dataIv = encrypted.subarray(offset, offset + IV_LENGTH); offset += IV_LENGTH;
  const dataAuthTag = encrypted.subarray(offset, offset + AUTH_TAG_LENGTH); offset += AUTH_TAG_LENGTH;
  const ciphertext = encrypted.subarray(offset);

  const aad = buildAad(mode, kekVersionId);

  return { mode, kekVersionId, salt, kekIv, kekAuthTag, encryptedDek, dataIv, dataAuthTag, ciphertext, aad };
}

function unwrapDekV2(header: V2HeaderFields, resolved: ResolvedEncryption): Buffer {
  // Try primary key
  const dek = tryUnwrapDek(resolved, header.salt, header.kekIv, header.kekAuthTag, header.encryptedDek, header.aad);
  if (dek) return dek;

  // Try previous keys
  if (resolved.previousKeys) {
    for (const prev of resolved.previousKeys) {
      const prevDek = tryUnwrapDek(prev, header.salt, header.kekIv, header.kekAuthTag, header.encryptedDek, header.aad);
      if (prevDek) return prevDek;
    }
  }

  throw new EncryptionError('Decryption failed: wrong key or corrupted data');
}

function decryptDataWithDek(dek: Buffer, header: V2HeaderFields): Buffer {
  try {
    const decipher = createDecipheriv(ALGORITHM, dek, header.dataIv);
    decipher.setAuthTag(header.dataAuthTag);
    return Buffer.concat([decipher.update(header.ciphertext), decipher.final()]);
  } catch {
    throw new EncryptionError('Decryption failed: wrong key or corrupted data');
  }
}

function decryptBufferV2(encrypted: Buffer, resolved: ResolvedEncryption): { plaintext: Buffer; dek: Buffer } {
  const header = parseV2Header(encrypted);
  const dek = unwrapDekV2(header, resolved);
  const plaintext = decryptDataWithDek(dek, header);
  return { plaintext, dek };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext buffer using AES-256-GCM with v2 envelope encryption.
 *
 * A random DEK (Data Encryption Key) is generated per call. The DEK encrypts
 * the data, and the DEK itself is encrypted with the user's KEK (Key Encryption
 * Key). This enables O(1) key rotation via {@link rekeyBuffer}.
 *
 * Output format (110-byte header + ciphertext):
 *   [0]       format version (2)
 *   [1]       key mode: 0=raw, 1=password (for KEK)
 *   [2..5]    KEK version ID (uint32 LE)
 *   [6..21]   salt (16 bytes, zeros for raw key mode)
 *   [22..33]  KEK-IV (12 bytes, random)
 *   [34..49]  KEK-auth-tag (16 bytes)
 *   [50..81]  encrypted DEK (32 bytes)
 *   [82..93]  data-IV (12 bytes, random)
 *   [94..109] data-auth-tag (16 bytes)
 *   [110..N]  ciphertext
 */
export function encryptBuffer(plaintext: Buffer, resolved: ResolvedEncryption): Buffer {
  return encryptBufferV2(plaintext, resolved).buffer;
}

/**
 * Encrypt a plaintext buffer and return both the encrypted output and the DEK.
 * Used by drivers that cache the DEK for WAL entry encryption.
 */
export function encryptBufferWithDek(plaintext: Buffer, resolved: ResolvedEncryption): { buffer: Buffer; dek: Buffer } {
  return encryptBufferV2(plaintext, resolved);
}

/**
 * Decrypt a buffer encrypted by {@link encryptBuffer} (v1 or v2 format).
 * @throws {EncryptionError} If the buffer is malformed or decryption fails.
 */
export function decryptBuffer(encrypted: Buffer, resolved: ResolvedEncryption): Buffer {
  if (encrypted.length < V1_HEADER_SIZE) {
    throw new EncryptionError('Encrypted data is too short or has an invalid format');
  }

  const version = encrypted.readUInt8(0);

  if (version === FORMAT_VERSION_V1) {
    return decryptBufferV1(encrypted, resolved);
  }

  if (version === FORMAT_VERSION_V2) {
    return decryptBufferV2(encrypted, resolved).plaintext;
  }

  // Detect unencrypted Trovec files
  if (version === 0x56 /* 'V' */) {
    throw new EncryptionError(
      'Source buffer appears to be an unencrypted Trovec file. ' +
      'To enable encryption on an existing collection, migrate it first — ' +
      'e.g. `trovec migrate --source <plaintext-dir> --dest <encrypted-dir> --new-key <hex>` ' +
      'or call `migrateCollection()` from @trovec/core.',
    );
  }

  throw new EncryptionError(`Unsupported encryption format version: ${version}`);
}

/**
 * Decrypt a buffer and return both the plaintext and the DEK.
 * Used by drivers that cache the DEK for WAL entry encryption.
 * For v1 input, the DEK is the resolved key itself (no envelope).
 */
export function decryptBufferWithDek(encrypted: Buffer, resolved: ResolvedEncryption): { plaintext: Buffer; dek: Buffer } {
  if (encrypted.length < V1_HEADER_SIZE) {
    throw new EncryptionError('Encrypted data is too short or has an invalid format');
  }

  const version = encrypted.readUInt8(0);

  if (version === FORMAT_VERSION_V1) {
    // v1 has no DEK — the resolved key IS the data key
    const plaintext = decryptBufferV1(encrypted, resolved);
    const dek = resolved.mode === KEY_MODE_RAW
      ? resolved.key!
      : deriveKey(resolved.password!, encrypted.subarray(2, 2 + SALT_LENGTH), resolved.iterations);
    return { plaintext, dek };
  }

  if (version === FORMAT_VERSION_V2) {
    return decryptBufferV2(encrypted, resolved);
  }

  if (version === 0x56 /* 'V' */) {
    throw new EncryptionError(
      'Source buffer appears to be an unencrypted Trovec file. ' +
      'To enable encryption on an existing collection, migrate it first — ' +
      'e.g. `trovec migrate --source <plaintext-dir> --dest <encrypted-dir> --new-key <hex>` ' +
      'or call `migrateCollection()` from @trovec/core.',
    );
  }

  throw new EncryptionError(`Unsupported encryption format version: ${version}`);
}

/**
 * Extract the DEK from a v2 encrypted buffer without decrypting the data payload.
 * @throws {EncryptionError} If the buffer is not v2 format or the key is wrong.
 */
export function unwrapDekFromBuffer(encrypted: Buffer, resolved: ResolvedEncryption): Buffer {
  if (encrypted.length < 1) {
    throw new EncryptionError('Encrypted data is too short or has an invalid format');
  }
  const version = encrypted.readUInt8(0);
  if (version !== FORMAT_VERSION_V2) {
    throw new EncryptionError(
      `unwrapDekFromBuffer requires v2 format (got version ${version}). ` +
      'Migrate the collection to v2 first.',
    );
  }
  if (encrypted.length < V2_HEADER_SIZE) {
    throw new EncryptionError('Encrypted data is too short for v2 envelope format');
  }
  const header = parseV2Header(encrypted);
  return unwrapDekV2(header, resolved);
}

/**
 * Rekey a v2 encrypted buffer by re-wrapping the DEK with a new KEK.
 * The data ciphertext is NOT re-encrypted — only the 110-byte header changes.
 * This is an O(1) operation regardless of data size.
 *
 * @param oldResolved - The current KEK used to unwrap the DEK.
 * @param newResolved - The new KEK to wrap the DEK with.
 * @param encrypted - The v2 encrypted buffer to rekey.
 * @returns A new buffer with the DEK re-wrapped under the new KEK.
 * @throws {EncryptionError} If the buffer is not v2 format or oldResolved is wrong.
 */
export function rekeyBuffer(oldResolved: ResolvedEncryption, newResolved: ResolvedEncryption, encrypted: Buffer): Buffer {
  if (encrypted.length < 1) {
    throw new EncryptionError('Encrypted data is too short or has an invalid format');
  }
  const version = encrypted.readUInt8(0);
  if (version !== FORMAT_VERSION_V2) {
    throw new EncryptionError(
      `rekeyBuffer requires v2 format (got version ${version}). ` +
      'Migrate the collection to v2 format first using `trovec migrate --upgrade-format`.',
    );
  }
  if (encrypted.length < V2_HEADER_SIZE) {
    throw new EncryptionError('Encrypted data is too short for v2 envelope format');
  }

  // Unwrap DEK with old KEK
  const header = parseV2Header(encrypted);
  const dek = unwrapDekV2(header, oldResolved);

  // Re-wrap DEK with new KEK
  let newSalt: Buffer;
  let newKek: Buffer;
  if (newResolved.mode === KEY_MODE_RAW) {
    newKek = newResolved.key!;
    newSalt = Buffer.alloc(SALT_LENGTH);
  } else {
    newSalt = randomBytes(SALT_LENGTH);
    newKek = deriveKey(newResolved.password!, newSalt, newResolved.iterations);
  }

  const newAad = buildAad(newResolved.mode, newResolved.kekVersionId);
  const newKekIv = randomBytes(IV_LENGTH);
  const kekCipher = createCipheriv(ALGORITHM, newKek, newKekIv);
  kekCipher.setAAD(newAad);
  const newEncryptedDek = Buffer.concat([kekCipher.update(dek), kekCipher.final()]);
  const newKekAuthTag = kekCipher.getAuthTag();

  // Build new buffer: new header + original data section (from offset 82 onward)
  const dataSection = encrypted.subarray(82); // dataIv + dataAuthTag + ciphertext
  const output = Buffer.alloc(82 + dataSection.length);
  let offset = 0;

  output.writeUInt8(FORMAT_VERSION_V2, offset); offset += 1;
  output.writeUInt8(newResolved.mode, offset); offset += 1;
  output.writeUInt32LE(newResolved.kekVersionId, offset); offset += KEK_VERSION_SIZE;
  newSalt.copy(output, offset); offset += SALT_LENGTH;
  newKekIv.copy(output, offset); offset += IV_LENGTH;
  newKekAuthTag.copy(output, offset); offset += AUTH_TAG_LENGTH;
  newEncryptedDek.copy(output, offset); offset += ENCRYPTED_DEK_SIZE;
  dataSection.copy(output, offset);

  return output;
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
