// === Public types ===

/** Unique identifier for a vector entry. Supports both string and bigint values. */
export type EntryId = string | bigint;

/** A vector entry stored in the database. */
export interface Entry {
  /** Unique identifier for this entry. */
  id: EntryId;
  /** The embedding vector as an array of numbers. Length must match the configured dimensions. */
  embedding: number[];
  /** Optional arbitrary metadata attached to this entry. Used for filtering during queries. */
  context?: Record<string, unknown>;
}

/** A single result returned from a similarity search. */
export interface QueryResult {
  /** Identifier of the matched entry. */
  id: EntryId;
  /** Similarity score. Higher values indicate greater similarity. */
  score: number;
  /** Metadata of the matched entry, if it was stored. */
  context?: Record<string, unknown>;
}

/**
 * Vector quantization strategy that controls storage size and precision trade-offs.
 *
 * - `'F32'` — Full 64-bit float precision (no compression).
 * - `'INT8'` — 8-bit integer quantization (lower memory, slight precision loss).
 * - `'BIT'` — Binary quantization (smallest footprint, requires `'hamming'` metric).
 */
export type QuantizationType = 'F32' | 'INT8' | 'BIT';

/**
 * Distance metric used to compare embedding vectors.
 *
 * - `'cosine'` — Cosine similarity (direction-based, ignores magnitude).
 * - `'euclidean'` — Euclidean distance converted to a similarity score.
 * - `'dot'` — Dot product similarity.
 * - `'hamming'` — Hamming similarity (requires `'BIT'` quantization).
 */
export type MetricType = 'cosine' | 'euclidean' | 'dot' | 'hamming';

/** Parameters for a vector similarity search. */
export interface QueryParams {
  /** The query embedding vector. Length must match the configured dimensions. */
  vector: number[];
  /**
   * Maximum number of results to return.
   * @defaultValue 10
   */
  topK?: number;
  /**
   * Optional predicate to filter entries by their context metadata before ranking.
   * Return `true` to include the entry, `false` to exclude it.
   */
  filter?: (context: Record<string, unknown> | undefined) => boolean;
}

/** The result of an embedding operation. */
export interface EmbedResult {
  /** The generated embedding vector. */
  embedding: number[];
}

/**
 * Provider interface for generating vector embeddings from text.
 * Implement this interface or use an adapter package (e.g. `@trovec/embedder-openai`).
 */
export interface Embedder {
  /** The number of dimensions in the vectors produced by this embedder. */
  readonly dimensions: number;
  /** Optional model identifier (e.g. `"text-embedding-3-small"`). */
  readonly model?: string;
  /** Generate an embedding vector for a single text input. */
  embed(input: string): Promise<EmbedResult>;
  /** Generate embedding vectors for multiple text inputs in a single batch call. */
  embedMany(input: string[]): Promise<EmbedResult[]>;
}

/** Configuration options for creating a Trovec instance. */
export interface TrovecConfig {
  /**
   * Number of dimensions for the embedding vectors.
   * Required unless an {@link Embedder} is provided, in which case the embedder's
   * dimensions are used and must match if both are specified.
   */
  dimensions?: number;
  /**
   * Vector quantization strategy.
   * @defaultValue `'F32'`
   */
  quantization?: QuantizationType;
  /**
   * Distance metric for similarity comparisons.
   * @defaultValue `'cosine'`
   */
  metric?: MetricType;
  /**
   * Storage backend for persisting data. When omitted, data is kept in memory only
   * and lost when the process exits.
   * @see {@link createMemoryDriver} and {@link createFileDriver}
   */
  storageDriver?: StorageDriver;
  /**
   * Embedding provider for text-based operations like {@link Trovec.addWithText}
   * and {@link Trovec.queryByText}.
   */
  embedder?: Embedder;
  /**
   * Identifier for this collection in the storage driver. Auto-generated if omitted.
   * @defaultValue `"trovec_<counter>"`
   */
  collectionId?: string;
  /**
   * Controls automatic persistence after mutations.
   * - `true` or `undefined` — auto-flush with a 500 ms debounce (only when a storage driver is set).
   * - `false` — disable auto-flush; you must call {@link Trovec.flush} manually.
   * - A positive number — custom debounce delay in milliseconds.
   * @defaultValue `true` (500 ms debounce when a storage driver is present)
   */
  autoFlush?: boolean | number;
}

/** Runtime statistics about a Trovec collection. */
export interface TrovecStats {
  /** Number of entries currently stored. */
  entryCount: number;
  /** Configured vector dimensions. */
  dimensions: number;
  /** Active quantization strategy. */
  quantization: QuantizationType;
  /** Active similarity metric. */
  metric: MetricType;
  /** Current index type. Only `'brute-force'` is supported. */
  indexStatus: 'brute-force';
}

/**
 * Abstract storage backend interface.
 * Implement this to add custom persistence (e.g. S3, Redis, SQLite).
 */
export interface StorageDriver {
  /** Persist serialized collection data under the given collection ID. */
  write(collectionId: string, data: Buffer): Promise<void>;
  /** Read previously persisted data, or `null` if nothing is stored. */
  read(collectionId: string): Promise<Buffer | null>;
  /** Check whether data exists for the given collection ID. */
  exists(collectionId: string): Promise<boolean>;
  /** Delete stored data for the given collection ID. Returns `true` if data existed. */
  delete(collectionId: string): Promise<boolean>;
}

/** Configuration options for the file-based storage driver. */
export interface FileDriverOptions {
  /**
   * Directory path where `.trovec` files are stored.
   * @defaultValue `".trovec"`
   */
  directory?: string;
  /**
   * Whether to apply Brotli compression when writing.
   * @defaultValue `true`
   */
  compression?: boolean;
  /**
   * Brotli compression quality level (0–11). Lower values are faster.
   * @defaultValue `1`
   */
  compressionLevel?: number;
}

/** File-based storage driver with Brotli compression support. */
export interface FileStorageDriver extends StorageDriver {
  /** Resolved absolute path of the storage directory. */
  readonly directory: string;
  /** Delete the entire storage directory and all collection files within it. */
  destroy(): Promise<void>;
}

/** Configuration options for encryption at rest. */
export interface EncryptionOptions {
  /** Raw 32-byte encryption key. Mutually exclusive with `password`. */
  key?: Buffer;
  /** Password for PBKDF2 key derivation. Mutually exclusive with `key`. */
  password?: string;
  /**
   * Number of PBKDF2 iterations for password-based key derivation.
   * Only used with `password`.
   * @defaultValue `100_000`
   */
  iterations?: number;
}

/** Configuration options for the concurrent file-based storage driver. */
export interface ConcurrentFileDriverOptions extends FileDriverOptions {
  /**
   * Time in milliseconds after which a lock is considered stale (process crashed).
   * @defaultValue `30_000`
   */
  staleLockTimeout?: number;
  /**
   * Maximum time in milliseconds to wait when acquiring a lock.
   * @defaultValue `10_000`
   */
  lockAcquireTimeout?: number;
  /**
   * Interval in milliseconds between lock acquisition retry attempts.
   * @defaultValue `200`
   */
  lockRetryInterval?: number;
  /**
   * Enable Write-Ahead Log for delta-based persistence instead of full-collection rewrites.
   * @defaultValue `false`
   */
  wal?: boolean;
  /**
   * Number of WAL entries before an automatic checkpoint compacts the WAL into the base file.
   * Only applies when `wal` is `true`.
   * @defaultValue `1000`
   */
  checkpointThreshold?: number;
  /**
   * Whether to automatically checkpoint the WAL when `close()` is called.
   * Only applies when `wal` is `true`.
   * @defaultValue `true`
   */
  checkpointOnClose?: boolean;
  /**
   * Encryption options for encrypting data at rest.
   * When set, both the base collection file and WAL entries are encrypted using AES-256-GCM.
   */
  encryption?: EncryptionOptions;
}

/** Concurrent file-based storage driver with file locking and optional WAL support. */
export interface ConcurrentFileStorageDriver extends FileStorageDriver {
  /** Compact the WAL into the base file. No-op if WAL is not enabled or is empty. */
  checkpoint(collectionId: string): Promise<void>;
}

/** A single WAL operation representing an add or delete mutation. */
export type WalOperation =
  | { type: 'put'; id: EntryId; quantized: QuantizedVector; context?: Record<string, unknown> }
  | { type: 'delete'; id: EntryId };

/** Storage driver that supports WAL-based delta persistence. */
export interface WalAwareDriver extends StorageDriver {
  /** Discriminant flag for runtime feature detection. */
  readonly walEnabled: true;
  /** Append delta operations to the WAL file. */
  appendWal(collectionId: string, ops: WalOperation[]): Promise<void>;
  /** Compact WAL into a full snapshot. */
  checkpoint(collectionId: string, data: Buffer): Promise<void>;
}

/**
 * Type guard to check if a storage driver supports WAL operations.
 * @param driver - The storage driver to check.
 */
export function isWalAwareDriver(driver: StorageDriver): driver is WalAwareDriver {
  return 'walEnabled' in driver && (driver as WalAwareDriver).walEnabled === true;
}

// === Internal types ===

export interface QuantizedVector {
  data: Float64Array | Int8Array | Buffer;
  min?: number;
  max?: number;
  dimensions?: number;
}

export interface StoredEntry {
  id: EntryId;
  quantized: QuantizedVector;
  context?: Record<string, unknown>;
}

export interface QuantizationCodec {
  type: QuantizationType;
  encode(embedding: number[]): QuantizedVector;
  decode(quantized: QuantizedVector): number[];
}

export type SimilarityFn = (a: QuantizedVector, b: QuantizedVector) => number;

/**
 * Fully resolved and validated configuration, derived from {@link TrovecConfig}.
 *
 * All optional fields have been filled with their defaults. This is the shape
 * stored on {@link TrovecInstance.config} after creation.
 */
export interface ResolvedTrovecConfig {
  /** Vector dimensions (always a positive integer after validation). */
  dimensions: number;
  /** Resolved quantization strategy. */
  quantization: QuantizationType;
  /** Resolved similarity metric. */
  metric: MetricType;
  /** Resolved storage driver (falls back to a no-op driver if none was provided). */
  storageDriver: StorageDriver;
  /** Embedding provider, if one was configured. */
  embedder?: Embedder;
  /** Resolved collection identifier. */
  collectionId: string;
  /** Auto-flush delay in milliseconds, or `false` if disabled. */
  autoFlush: false | number;
}

/**
 * Low-level representation of a Trovec database instance.
 *
 * Most consumers should use the {@link Trovec} fluent interface returned by {@link create}.
 * This interface is exposed for advanced or functional-style usage where the instance
 * is passed as the first argument to standalone functions (e.g. `add(instance, entry)`).
 */
export interface TrovecInstance {
  /** Frozen, resolved configuration derived from the options passed to {@link create}. */
  readonly config: Readonly<ResolvedTrovecConfig>;
  /** Internal map of stored entries, keyed by serialized entry ID. */
  entries: Map<string, StoredEntry>;
  /** Quantization codec used to encode/decode embedding vectors. */
  codec: QuantizationCodec;
  /** Similarity function used to compare quantized vectors during queries. */
  similarityFn: SimilarityFn;
  /** Whether the collection has unsaved changes since the last flush. */
  dirty: boolean;
  /** Identifier for this collection in the storage driver. */
  collectionId: string;
  /** @internal Debounced flush scheduler; set when auto-flush is enabled. */
  _scheduleFlush?: () => void;
  /** @internal Handle for the pending auto-flush timer. */
  _flushTimer?: ReturnType<typeof setTimeout>;
  /** @internal Promise tracking an in-progress flush to prevent concurrent writes. */
  _flushing?: Promise<void>;
  /** @internal `beforeExit` listener reference, used for cleanup in {@link close}. */
  _beforeExitHandler?: () => void;
  /** @internal Buffer for WAL operations when using a WAL-aware storage driver. */
  _walBuffer?: WalOperation[];
}

// === Text types (used by embedder + fluent API) ===

/** A text entry to be embedded and stored. Used with {@link Trovec.addWithText}. */
export interface TextEntry {
  /** Unique identifier for this entry. */
  id: EntryId;
  /** Raw text to be converted into an embedding via the configured {@link Embedder}. */
  text: string;
  /** Optional arbitrary metadata attached to this entry. */
  context?: Record<string, unknown>;
}

/** Parameters for a text-based similarity search. Used with {@link Trovec.queryByText}. */
export interface TextQueryParams {
  /** Query text to be converted into an embedding via the configured {@link Embedder}. */
  text: string;
  /**
   * Maximum number of results to return.
   * @defaultValue 10
   */
  topK?: number;
  /**
   * Optional predicate to filter entries by their context metadata before ranking.
   * Return `true` to include the entry, `false` to exclude it.
   */
  filter?: (context: Record<string, unknown> | undefined) => boolean;
}

// === Fluent API ===

/**
 * A Trovec vector database instance with a fluent (method-chaining) API.
 * Created by calling {@link create}.
 *
 * @example
 * ```ts
 * import { create, createFileDriver } from '@trovec/core';
 *
 * const db = await create({
 *   dimensions: 384,
 *   storageDriver: createFileDriver(),
 * });
 *
 * db.add({ id: 'doc-1', embedding: [...], context: { title: 'Hello' } });
 * const results = db.query({ vector: [...], topK: 5 });
 * await db.close();
 * ```
 */
export interface Trovec extends TrovecInstance {
  // Collection

  /**
   * Add a single vector entry to the collection.
   * @throws {DimensionMismatchError} If the embedding length does not match configured dimensions.
   */
  add(entry: Entry): void;
  /**
   * Add multiple vector entries in a single atomic batch.
   * All entries are validated before any are inserted — if one fails, none are added.
   * @throws {DimensionMismatchError} If any embedding length does not match configured dimensions.
   */
  addMany(entries: Entry[]): void;
  /**
   * Retrieve an entry by its ID, decoding the stored quantized vector back to floats.
   * @returns The entry, or `undefined` if no entry exists with the given ID.
   */
  get(id: EntryId): Entry | undefined;
  /**
   * Delete an entry by its ID.
   * @returns `true` if the entry existed and was removed, `false` otherwise.
   */
  delete(id: EntryId): boolean;

  // Query

  /**
   * Perform a brute-force similarity search against all entries.
   * Results are sorted by descending similarity score.
   * @throws {DimensionMismatchError} If the query vector length does not match configured dimensions.
   */
  query(params: QueryParams): QueryResult[];

  // Core

  /** Get runtime statistics about this collection (entry count, config, index type). */
  stats(): TrovecStats;
  /**
   * Persist all pending changes to the storage driver immediately.
   * No-op if no storage driver is configured.
   */
  flush(): Promise<void>;
  /**
   * Flush any pending changes, remove event listeners, and disable auto-flush.
   * Always call this when you are done with the instance to prevent resource leaks.
   */
  close(): Promise<void>;

  // Embedder (requires embedder in config)

  /**
   * Generate an embedding for a single text input using the configured {@link Embedder}.
   * @throws {TrovecError} If no embedder is configured.
   */
  embed(input: string): Promise<EmbedResult>;
  /**
   * Generate embeddings for multiple text inputs in a single batch call.
   * @throws {TrovecError} If no embedder is configured.
   */
  embedMany(input: string[]): Promise<EmbedResult[]>;
  /**
   * Embed the entry's text and add the resulting vector to the collection.
   * @throws {TrovecError} If no embedder is configured.
   * @throws {DimensionMismatchError} If the generated embedding does not match configured dimensions.
   */
  addWithText(entry: TextEntry): Promise<void>;
  /**
   * Embed multiple text entries and add them all to the collection in a single batch.
   * @throws {TrovecError} If no embedder is configured.
   * @throws {DimensionMismatchError} If any generated embedding does not match configured dimensions.
   */
  addManyWithText(entries: TextEntry[]): Promise<void>;
  /**
   * Embed the query text and perform a similarity search against all entries.
   * @throws {TrovecError} If no embedder is configured.
   */
  queryByText(params: TextQueryParams): Promise<QueryResult[]>;

  // Serialization

  /**
   * Serialize the entire collection to a binary buffer.
   * Useful for manual snapshots or transferring data between instances.
   */
  serialize(): Buffer;
  /**
   * Replace the current collection contents with data from a serialized buffer.
   * @throws {Error} If the buffer format, dimensions, or quantization type do not match.
   */
  deserialize(buffer: Buffer): void;
}
