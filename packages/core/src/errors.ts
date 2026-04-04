/** Base error class for all Trovec errors. */
export class TrovecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrovecError';
  }
}

/** Thrown when an embedding vector's length does not match the configured dimensions. */
export class DimensionMismatchError extends TrovecError {
  constructor(expected: number, got: number) {
    super(`Expected embedding of dimension ${expected} but got ${got}`);
    this.name = 'DimensionMismatchError';
  }
}

/** Thrown when a Trovec configuration or entry is invalid. */
export class InvalidConfigError extends TrovecError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConfigError';
  }
}

/** Thrown when a file lock cannot be acquired within the configured timeout. */
export class LockTimeoutError extends TrovecError {
  constructor(lockPath: string, timeoutMs: number) {
    super(`Failed to acquire lock "${lockPath}" within ${timeoutMs}ms`);
    this.name = 'LockTimeoutError';
  }
}

/** Thrown when encryption or decryption fails (wrong key, corrupted data, invalid config). */
export class EncryptionError extends TrovecError {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

/** Thrown when a WAL file contains corrupted entries that cannot be replayed. */
export class WalCorruptionError extends TrovecError {
  /** Number of valid entries recovered before corruption was detected. */
  readonly validEntries: number;

  constructor(message: string, validEntries: number) {
    super(message);
    this.name = 'WalCorruptionError';
    this.validEntries = validEntries;
  }
}
