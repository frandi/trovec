import { stat, access, readFile as fsReadFile, writeFile as fsWriteFile, mkdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createConcurrentFileDriver } from './concurrent-file.js';
import { withEncryption, rekeyBuffer, resolveEncryptionKey, FORMAT_VERSION_V2 } from './encryption.js';
import { readWalEntries } from './wal.js';
import { EncryptionError, InvalidConfigError } from '../errors.js';
import type { EncryptionOptions, QuantizationType } from '../types.js';

/**
 * Options for {@link migrateCollection}.
 */
export interface MigrateCollectionOptions {
  /** Directory containing the source `<collectionId>.trovec` file. */
  sourceDirectory: string;
  /** Directory to write the migrated `<collectionId>.trovec` file into. Created if missing. */
  destDirectory: string;
  /** Collection ID (i.e. the base filename without the `.trovec` suffix). */
  collectionId: string;
  /**
   * Collection ID for the destination file. Omit to reuse `collectionId`.
   * Use this when the destination is written into the **same** directory as
   * the source — e.g. migrating `data.trovec` → `data-enc.trovec` in place.
   */
  destCollectionId?: string;
  /**
   * Encryption options used to read the source. Omit when the source is plaintext.
   */
  sourceEncryption?: EncryptionOptions;
  /**
   * Encryption options used when writing the destination. Omit to write plaintext.
   */
  destEncryption?: EncryptionOptions;
  /**
   * Overwrite the destination collection file if it already exists.
   * @defaultValue `false`
   */
  force?: boolean;
  /**
   * Round-trip verify the destination by reading it back and comparing the
   * decrypted plaintext byte-for-byte to the source plaintext.
   * @defaultValue `true`
   */
  verify?: boolean;
  /**
   * Attempt O(1) header-only rekey. Only works when both source and destination
   * use encryption and the source is v2 envelope format. Falls back to full
   * migration if conditions are not met.
   * @defaultValue `false`
   */
  fastRekey?: boolean;
  /**
   * Force the output to v2 envelope format even if source and destination use
   * the same key. Useful for explicitly upgrading from v1 to v2 format.
   * @defaultValue `false`
   */
  upgradeFormat?: boolean;
}

/**
 * Result returned by {@link migrateCollection}.
 */
export interface MigrationResult {
  /** Number of entries in the migrated collection (base + replayed WAL). */
  entryCount: number;
  /** Size of the source `.trovec` file on disk, in bytes. */
  sourceFileBytes: number;
  /** Size of the destination `.trovec` file on disk, in bytes. */
  destFileBytes: number;
  /** `true` if the source had a `.trovec.wal` sidecar whose entries were checkpointed into the dest. */
  walCheckpointed: boolean;
  /** `true` if the fast O(1) header-only rekey path was used. */
  fastRekeyed: boolean;
}

function sourceFilePath(dir: string, collectionId: string): string {
  return join(resolve(dir), `${collectionId}.trovec`);
}

function walFilePath(dir: string, collectionId: string): string {
  return join(resolve(dir), `${collectionId}.trovec.wal`);
}

function lockFilePath(dir: string, collectionId: string): string {
  return join(resolve(dir), `${collectionId}.trovec.lock`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse the entry count field (uint32 LE at offset 11) from a plaintext Trovec buffer.
 * See `packages/core/src/serialization.ts` for the full header layout.
 */
function readEntryCount(buffer: Buffer): number {
  if (buffer.length < 16) return 0;
  return buffer.readUInt32LE(11);
}

function readConfigFromHeader(buffer: Buffer): { dimensions: number; quantization: QuantizationType } | null {
  if (buffer.length < 16) return null;
  const QUANT_REVERSE: QuantizationType[] = ['F32', 'INT8', 'BIT'];
  return {
    dimensions: buffer.readUInt32LE(5),
    quantization: QUANT_REVERSE[buffer.readUInt8(9)],
  };
}

/**
 * Non-destructively migrate a Trovec collection to a new directory, optionally
 * adding, removing, or rotating encryption at rest.
 *
 * The migration is a driver-level buffer copy:
 *
 *   1. Open the source with a `createConcurrentFileDriver` (WAL-aware) and the
 *      source encryption key (if any). Call `.read()` to obtain the fully
 *      checkpointed plaintext buffer — this transparently replays any pending
 *      WAL entries and decrypts them.
 *   2. Open the destination with a fresh `createConcurrentFileDriver` (no WAL)
 *      and the destination encryption key (if any). Call `.write()` to persist
 *      the plaintext buffer, letting the driver handle compression and
 *      encryption.
 *   3. If `verify` is enabled (the default), re-read the destination and
 *      compare the round-tripped plaintext to the source plaintext byte-for-byte.
 *
 * When `fastRekey` is enabled and both source/destination use encryption with
 * a v2 source file, the migration rewrites only the 110-byte header (O(1)
 * regardless of data size). The data ciphertext is preserved byte-for-byte.
 *
 * The source directory is not mutated: its base file, WAL sidecar, and
 * configuration remain untouched. (Transient `.lock` files may be created by
 * the concurrent driver during reads, but they are cleaned up before this
 * function returns.)
 *
 * ### Safety checks
 * - Refuses to run if a `.lock` file is present in the source (likely another
 *   writer is still attached to the collection).
 * - Refuses to overwrite an existing destination file unless `force` is set.
 * - Refuses the trivial plain→plain case (both encryption options undefined)
 *   unless `upgradeFormat` is set. Use `cp` for that.
 *
 * ### What this function does NOT do
 * - Does not touch adjacent files (application-specific registries, uploads,
 *   etc.). The caller is responsible for copying those across.
 * - Does not archive or delete the source directory. Callers should archive
 *   the source themselves after verifying the migration.
 * - Does not acquire a write lock on the source. The caller is expected to
 *   stop any writers before migrating; the `.lock` file pre-check catches the
 *   common mistake of forgetting to do so.
 *
 * @example
 * ```ts
 * // Enable encryption on an existing plaintext collection.
 * await migrateCollection({
 *   sourceDirectory: './.trovec',
 *   destDirectory: './.trovec-encrypted',
 *   collectionId: 'default',
 *   destEncryption: { key: Buffer.from(process.env.TROVEC_ENCRYPTION_KEY!, 'hex') },
 * });
 * ```
 */
export async function migrateCollection(
  options: MigrateCollectionOptions,
): Promise<MigrationResult> {
  const {
    sourceDirectory,
    destDirectory,
    collectionId,
    destCollectionId,
    sourceEncryption,
    destEncryption,
    force = false,
    verify = true,
    fastRekey = false,
    upgradeFormat = false,
  } = options;

  if (!sourceEncryption && !destEncryption && !upgradeFormat) {
    throw new InvalidConfigError(
      'Migration requires a change in encryption state (add, remove, or rotate). ' +
      'For a plain-to-plain copy, use filesystem tools (e.g. cp -r). ' +
      'To upgrade encryption format without changing keys, pass upgradeFormat: true.',
    );
  }

  const destId = destCollectionId ?? collectionId;

  const sourcePath = sourceFilePath(sourceDirectory, collectionId);
  const destPath = sourceFilePath(destDirectory, destId);
  const sourceLockPath = lockFilePath(sourceDirectory, collectionId);
  const sourceWalPath = walFilePath(sourceDirectory, collectionId);

  // Refuse in-place migration onto the source file itself.
  if (resolve(sourcePath) === resolve(destPath)) {
    throw new InvalidConfigError(
      `Destination resolves to the source file (${sourcePath}). ` +
      `Use a different directory or pass destCollectionId to write a new file alongside the source.`,
    );
  }

  // Pre-flight: source file must exist.
  let sourceStat;
  try {
    sourceStat = await stat(sourcePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new InvalidConfigError(
        `Source collection file not found: ${sourcePath}. ` +
        `Verify that sourceDirectory and collectionId are correct.`,
      );
    }
    throw err;
  }

  // Pre-flight: refuse if a writer appears to be active on the source.
  if (await exists(sourceLockPath)) {
    throw new InvalidConfigError(
      `Source collection appears to be in use by another process (found lock file: ${sourceLockPath}). ` +
      `Stop the writer before migrating.`,
    );
  }

  // Pre-flight: refuse to clobber an existing destination file unless forced.
  if (await exists(destPath) && !force) {
    throw new InvalidConfigError(
      `Destination file already exists: ${destPath}. Pass force=true to overwrite.`,
    );
  }

  const walCheckpointed = await exists(sourceWalPath);

  // ---------------------------------------------------------------------------
  // Fast rekey path — O(1) header-only rewrite for v2 sources
  // ---------------------------------------------------------------------------
  if (fastRekey && sourceEncryption && destEncryption && !walCheckpointed) {
    const rawSource = await fsReadFile(sourcePath);
    if (rawSource.length > 0 && rawSource[0] === FORMAT_VERSION_V2) {
      const oldResolved = resolveEncryptionKey(sourceEncryption);
      const newResolved = resolveEncryptionKey(destEncryption);
      const rekeyed = rekeyBuffer(oldResolved, newResolved, rawSource);
      await mkdir(resolve(destDirectory), { recursive: true });
      await fsWriteFile(destPath, rekeyed);

      // Verify by round-tripping
      if (verify) {
        // Decrypt source with old key
        const sourceDriver = createConcurrentFileDriver({ directory: sourceDirectory, wal: false });
        withEncryption(sourceDriver, sourceEncryption);
        const sourcePlaintext = await sourceDriver.read(collectionId);

        // Decrypt dest with new key
        const destDriver = createConcurrentFileDriver({ directory: destDirectory, wal: false });
        withEncryption(destDriver, destEncryption);
        const destPlaintext = await destDriver.read(destId);

        if (!sourcePlaintext || !destPlaintext || !destPlaintext.equals(sourcePlaintext)) {
          try { await unlink(destPath); } catch { /* best-effort cleanup */ }
          throw new EncryptionError(
            'Fast rekey verification failed: destination does not round-trip to source plaintext.',
          );
        }
      }

      const destStat = await stat(destPath);
      const entryCount = verify
        ? readEntryCount(
            // Already decrypted above during verification; re-read for count.
            // The source driver's read() returns plaintext so readEntryCount works.
            await (async () => {
              const d = createConcurrentFileDriver({ directory: sourceDirectory, wal: false });
              if (sourceEncryption) withEncryption(d, sourceEncryption);
              return (await d.read(collectionId))!;
            })(),
          )
        : 0; // Without verify, we don't decrypt — entry count unknown.

      return {
        entryCount,
        sourceFileBytes: sourceStat.size,
        destFileBytes: destStat.size,
        walCheckpointed: false,
        fastRekeyed: true,
      };
    }
    // Source is not v2 — fall through to full migration
  }

  // ---------------------------------------------------------------------------
  // Full migration path
  // ---------------------------------------------------------------------------

  // Open source driver and read the checkpointed plaintext buffer.
  const sourceDriver = createConcurrentFileDriver({
    directory: sourceDirectory,
    wal: true,
  });
  if (sourceEncryption) {
    withEncryption(sourceDriver, sourceEncryption);
  }

  const plaintext = await sourceDriver.read(collectionId);
  if (!plaintext) {
    // Pre-flight confirmed the file exists, so this indicates a race or a
    // corrupt file. Surface it as a config error so the caller can retry.
    throw new InvalidConfigError(
      `Source collection file exists but could not be read: ${sourcePath}.`,
    );
  }

  // If a WAL existed in the source, separately verify it had no truncated
  // (corrupt) tail entries. `sourceDriver.read()` silently drops truncated
  // entries, which is acceptable at runtime but not during a migration where
  // the caller expects either a complete copy or an error.
  if (walCheckpointed) {
    const config = readConfigFromHeader(plaintext);
    if (config) {
      const walTransforms = sourceEncryption
        ? await (async () => {
            // The concurrent driver already configured itself via
            // configureEncryption; recreate transforms locally for the
            // standalone WAL check.
            const { encryptBufferV1, decryptBuffer: localDecrypt, resolveEncryptionKey: localResolve } = await import('./encryption.js');
            const resolved = localResolve(sourceEncryption);
            // For v2 envelope encryption, WAL entries are encrypted with the
            // DEK (v1 format). We need the DEK — unwrap it from the base file.
            const { unwrapDekFromBuffer: localUnwrap } = await import('./encryption.js');
            const rawSource = await fsReadFile(sourcePath);
            let walResolved;
            if (rawSource.length > 0 && rawSource[0] === FORMAT_VERSION_V2) {
              const dek = localUnwrap(rawSource, resolved);
              walResolved = { mode: 0 as const, key: dek, iterations: 0, kekVersionId: 0 };
            } else {
              walResolved = resolved;
            }
            return {
              encrypt: (buf: Buffer) => encryptBufferV1(buf, walResolved),
              decrypt: (buf: Buffer) => localDecrypt(buf, walResolved),
            };
          })()
        : undefined;
      const walResult = await readWalEntries(sourceWalPath, config, walTransforms);
      if (walResult.truncated) {
        throw new EncryptionError(
          `Source WAL (${sourceWalPath}) has corrupted or truncated tail entries. ` +
          `Refusing to migrate to avoid silent data loss. ` +
          `Start the application once with the source directory to let it recover or checkpoint the WAL, then retry.`,
        );
      }
    }
  }

  // Open destination driver. `wal: false` keeps the destination as a single
  // clean base file with no sidecar — the ideal post-migration state.
  const destDriver = createConcurrentFileDriver({
    directory: destDirectory,
    wal: false,
  });
  if (destEncryption) {
    withEncryption(destDriver, destEncryption);
  }

  await destDriver.write(destId, plaintext);

  // Verification: round-trip the dest and compare plaintext.
  if (verify) {
    const roundtrip = await destDriver.read(destId);
    if (!roundtrip || !roundtrip.equals(plaintext)) {
      // Remove the bad artifact so it can't be mistaken for a valid migration.
      try {
        await unlink(destPath);
      } catch {
        // Best-effort cleanup; surface the original failure regardless.
      }
      throw new EncryptionError(
        'Migration verification failed: destination does not round-trip to source plaintext.',
      );
    }
  }

  const destStat = await stat(destPath);

  return {
    entryCount: readEntryCount(plaintext),
    sourceFileBytes: sourceStat.size,
    destFileBytes: destStat.size,
    walCheckpointed,
    fastRekeyed: false,
  };
}
