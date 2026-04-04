<p align="center">
  <img src="./icon.png" alt="Trovec" width="128" height="128" />
</p>

# @trovec/core

[![npm](https://img.shields.io/npm/v/@trovec/core)](https://www.npmjs.com/package/@trovec/core)

A lightweight, zero-dependency vector database library for Node.js. Store, query, and persist vector embeddings with support for multiple quantization types and similarity metrics.

## Features

- **Zero runtime dependencies** — only Node.js required
- **Multiple quantization modes** — F32 (full precision), INT8 (compressed), BIT (binary)
- **Four similarity metrics** — Cosine, Euclidean, Dot Product, Hamming
- **Fluent API** — `db.add()`, `db.query()`, `db.queryByText()` — clean and discoverable
- **Functional API** — stateless functions for tree-shaking and backward compatibility
- **Dual ESM/CJS** — works with both `import` and `require`
- **TypeScript-first** — full type definitions included
- **Mixed ID types** — supports both `string` and `bigint` entry IDs
- **Multi-process safe** — concurrent file driver with advisory locks, WAL, and crash recovery
- **Encryption at rest** — opt-in AES-256-GCM encryption for collection files and WAL entries
- **Pluggable Embedder** — bring your own embedding adapter for text-to-vector conversion

## Quick Start

### Installation

```bash
npm install @trovec/core
```

### Basic Usage

```typescript
import { create } from '@trovec/core';

// 1. Create an instance
const db = await create({ dimensions: 3 });

// 2. Add entries
db.add({ id: 'cat', embedding: [0.9, 0.1, 0.0], context: { type: 'animal' } });
db.add({ id: 'dog', embedding: [0.8, 0.2, 0.0], context: { type: 'animal' } });
db.add({ id: 'car', embedding: [0.0, 0.1, 0.9], context: { type: 'vehicle' } });

// 3. Query for similar vectors
const results = db.query({ vector: [1, 0, 0], topK: 2 });

console.log(results);
// [
//   { id: 'cat', score: 0.993..., context: { type: 'animal' } },
//   { id: 'dog', score: 0.970..., context: { type: 'animal' } }
// ]
```

### With Quantization and Filtering

```typescript
import { create } from '@trovec/core';

const db = await create({
  dimensions: 128,
  quantization: 'INT8',    // compress vectors to int8
  metric: 'euclidean',
});

// Batch insert
db.addMany([
  { id: 1n, embedding: new Array(128).fill(0.5), context: { category: 'A' } },
  { id: 2n, embedding: new Array(128).fill(0.3), context: { category: 'B' } },
  { id: 3n, embedding: new Array(128).fill(0.7), context: { category: 'A' } },
]);

// Query with filter
const results = db.query({
  vector: new Array(128).fill(0.6),
  topK: 5,
  filter: (ctx) => ctx?.category === 'A',
});
```

### Persistence

Trovec provides three built-in storage drivers:

#### File Storage (recommended for most use cases)

Persists data to disk with automatic Brotli compression. Data survives app restarts.

```typescript
import { create, createFileDriver } from '@trovec/core';

// Zero-config: defaults to .trovec/ directory with Brotli compression
const driver = createFileDriver();

// Or customize:
// const driver = createFileDriver({
//   directory: './my-data',    // default: '.trovec'
//   compression: true,         // default: true (Brotli)
//   compressionLevel: 1,       // default: 1 (fast), range: 0-11
// });

const db = await create({
  dimensions: 3,
  storageDriver: driver,
  collectionId: 'my-collection',
});
db.add({ id: 'a', embedding: [1, 2, 3] });
// Data auto-persists after a short debounce (default: 500ms)

// When done, close() flushes any pending changes and cleans up
await db.close();

// Later: create() auto-loads existing data from storage
const db2 = await create({
  dimensions: 3,
  storageDriver: driver,
  collectionId: 'my-collection',
});
// db2 already has the previously saved entries — no manual load needed

// Clean up all stored files when no longer needed
await driver.destroy();
```

The file driver:
- Auto-creates the directory on first write
- Uses atomic writes (temp file + rename) to prevent corruption
- Applies Brotli compression by default (typically 60-80% size reduction)
- Exposes `driver.directory` for inspecting the resolved path

> **Auto-flush:** When a `storageDriver` is configured, data is automatically persisted after a short debounce (default: 500ms). You can disable this with `autoFlush: false` or customize the delay with `autoFlush: 2000` (ms). See [Configuration](#configuration) for details.

#### Concurrent File Storage (multi-process safe)

Wraps file persistence with advisory file locks and an optional Write-Ahead Log (WAL). Use this when multiple Node.js processes may read/write the same collection simultaneously — for example, clustered servers or worker threads with separate event loops.

```typescript
import { create, createConcurrentFileDriver } from '@trovec/core';

// Locking only (safe multi-process, full-rewrite on flush)
const driver = createConcurrentFileDriver({ directory: './data' });

// WAL enabled (incremental appends instead of full rewrites — faster flushes)
const walDriver = createConcurrentFileDriver({
  directory: './data',
  wal: true,
});

const db = await create({
  dimensions: 384,
  storageDriver: walDriver,
  collectionId: 'my-collection',
});

db.add({ id: 'a', embedding: new Array(384).fill(0.5) });
await db.flush();
await db.close();
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `directory` | `'.trovec'` | Storage directory |
| `compression` | `true` | Brotli compression for base files |
| `compressionLevel` | `1` | Brotli quality (0-11, 1 = fast) |
| `wal` | `false` | Enable Write-Ahead Log for incremental persistence |
| `staleLockTimeout` | `30000` | ms before a lock is considered stale (crashed process) |
| `lockAcquireTimeout` | `10000` | ms to wait before giving up on lock acquisition |
| `lockRetryInterval` | `200` | ms between lock retry attempts |

**How it works:**

- **Locking** — Each operation (read, write, WAL append) acquires an exclusive file lock (`<collectionId>.trovec.lock`). The lock includes a heartbeat so crashed processes' stale locks are automatically recovered after `staleLockTimeout`.
- **Without WAL** — Every `flush()` rewrites the entire collection file (same as `createFileDriver`, but with locking).
- **With WAL** — The first flush writes a full base file. Subsequent flushes append only the changed entries to a `.trovec.wal` file. On `create()`, the base file and WAL are merged. Call `driver.checkpoint(collectionId, serializedData)` to compact the WAL back into the base file.
- **Crash safety** — WAL entries are individually checksummed (CRC32). If a process crashes mid-write, the next reader recovers all valid entries up to the point of interruption.

> **When to use which driver:**
> - **`createFileDriver()`** — single-process apps, simpler setup, no lock overhead
> - **`createConcurrentFileDriver()`** — multi-process apps, or when you need WAL for faster incremental flushes
> - **`createConcurrentFileDriver({ wal: true })`** — frequent small mutations where rewriting the full file each time is too expensive
>
> **Concurrency limits:** The concurrent driver uses exclusive file locks with sleep-polling, which works well for **a handful of concurrent processes** (roughly 2-10). Throughput stays stable in this range, but tail latency grows with contention — at 32 processes, individual flushes can stall for seconds. If your workload involves many concurrent writers with latency requirements, consider a purpose-built database engine. See the [concurrency docs](../../docs/concurrency.md) for empirical benchmarks and a detailed analysis.

#### Encryption at Rest

Trovec supports opt-in AES-256-GCM encryption for data at rest. This protects embedding vectors, entry IDs, and context metadata from unauthorized access — including protection against [vector inversion attacks](https://arxiv.org/abs/2310.06816) that can recover approximate original content from raw embeddings.

```typescript
import { create, createFileDriver, withEncryption } from '@trovec/core';
import { randomBytes } from 'node:crypto';

// Wrap any driver with encryption (raw 32-byte key)
const key = randomBytes(32);
const driver = withEncryption(createFileDriver(), { key });

const db = await create({ dimensions: 384, storageDriver: driver });
```

`withEncryption` works with any driver — including the concurrent file driver with WAL:

```typescript
import { createConcurrentFileDriver, withEncryption } from '@trovec/core';

const driver = withEncryption(
  createConcurrentFileDriver({ wal: true }),
  { key },  // or { password: 'my-passphrase' }
);
```

Password-based key derivation (PBKDF2) is also supported for convenience. See the [encryption docs](../../docs/encryption.md) for the full threat model, encrypted format specification, and performance analysis.

#### Memory Storage (for testing and ephemeral data)

Stores data in a `Map` — fast, but data is lost when the process exits.

```typescript
import { create, createMemoryDriver } from '@trovec/core';

const driver = createMemoryDriver();
const db = await create({ dimensions: 3, storageDriver: driver, collectionId: 'test' });

db.add({ id: 'a', embedding: [1, 2, 3] });
// Auto-flushes after debounce; or call close() for immediate flush + cleanup
await db.close();

// Data auto-loads on create()
const db2 = await create({ dimensions: 3, storageDriver: driver, collectionId: 'test' });
```

### Custom Storage Drivers

The `StorageDriver` interface is intentionally minimal — four async methods — making it straightforward to write drivers for any storage backend:

```typescript
import type { StorageDriver } from '@trovec/core';

interface StorageDriver {
  write(collectionId: string, data: Buffer): Promise<void>;
  read(collectionId: string): Promise<Buffer | null>;
  exists(collectionId: string): Promise<boolean>;
  delete(collectionId: string): Promise<boolean>;
}
```

This opens up several deployment scenarios:

| Environment | Approach |
|---|---|
| **Azure App Service / mounted disk** | Use the built-in `createFileDriver({ directory: '/mnt/data' })` — point to the mounted path |
| **Kubernetes with persistent volumes** | Same as above — point the directory to the mounted volume path |
| **Amazon S3 / Azure Blob Storage** | Implement `StorageDriver` using the respective SDK (`@aws-sdk/client-s3`, `@azure/storage-blob`) — `write` maps to `PutObject`/`uploadBlockBlob`, `read` to `GetObject`/`downloadToBuffer`, etc. |
| **Google Cloud Storage** | Implement using `@google-cloud/storage` — same pattern as S3/Azure Blob |
| **Redis / Memcached** | Implement using `ioredis` or similar — `write`/`read` map directly to `SET`/`GET` with binary data |
| **SQLite / PostgreSQL** | Store serialized buffers in a `BYTEA`/`BLOB` column keyed by collection ID |

> **Note:** Cloud storage drivers typically have higher latency (50-500ms per operation) compared to local file I/O (< 1ms). Since Trovec loads the full dataset into memory on `create()` and only touches storage on flush, this latency mainly affects startup and persist — queries remain sub-millisecond regardless of backend.
>
> Community contributions for storage drivers are welcome. Publish them as separate packages (e.g., `trovec-driver-s3`) to keep `@trovec/core` zero-dependency.

### Text Embedding (with adapter)

Trovec provides an `Embedder` interface for text-to-vector conversion. Install an adapter package, then use text-based methods:

```typescript
import { create } from '@trovec/core';
import { createOpenAIEmbedder } from '@trovec/embedder-openai'; // adapter package

const db = await create({
  embedder: createOpenAIEmbedder({ apiKey: process.env.OPENAI_API_KEY }),
});

// Add entries using text — embedding happens automatically
await db.addWithText({ id: 'doc1', text: 'The cat sat on the mat', context: { source: 'book' } });
await db.addWithText({ id: 'doc2', text: 'Dogs love to play fetch' });

// Query using text
const results = await db.queryByText({ text: 'animals sitting', topK: 5 });
```

> **No built-in embedder is included** — this keeps Trovec zero-dependency. Each adapter exposes a `dimensions` property, so Trovec can auto-configure itself. Available adapters:
>
> | Adapter | Default dimensions | Notes |
> |---------|-------------------|-------|
> | [`@trovec/embedder-local`](../embedder-local/) | 64 | Trigram hash, zero deps, offline — for testing/demos |
> | [`@trovec/embedder-ollama`](../embedder-ollama/) | 768 | Local Ollama server, no API key — good semantic quality |
> | [`@trovec/embedder-openai`](../embedder-openai/) | 1536 | OpenAI API — best semantic quality |
>
> See [Writing an Embedder Adapter](#writing-an-embedder-adapter) below for how to create your own.

## API Reference

`create()` returns a `Trovec` object with bound methods. All examples below use the fluent style. A functional API is also available for tree-shaking and backward compatibility (see [Functional API](#functional-api)).

### Lifecycle

| Method | Signature | Description |
|--------|-----------|-------------|
| `create` | `(config: TrovecConfig) => Promise<Trovec>` | Create a new instance (auto-loads from storage) |
| `db.flush()` | `() => Promise<void>` | Persist all data to storage immediately |
| `db.close()` | `() => Promise<void>` | Flush pending changes and disable auto-flush |
| `db.stats()` | `() => TrovecStats` | Get instance statistics |

### Collection Operations

| Method | Signature | Description |
|--------|-----------|-------------|
| `db.add(entry)` | `(entry: Entry) => void` | Insert or replace an entry |
| `db.addMany(entries)` | `(entries: Entry[]) => void` | Atomic batch insert (all-or-nothing) |
| `db.delete(id)` | `(id: EntryId) => boolean` | Remove an entry, returns `true` if it existed |
| `db.get(id)` | `(id: EntryId) => Entry \| undefined` | Retrieve an entry by ID |

### Query

| Method | Signature | Description |
|--------|-----------|-------------|
| `db.query(params)` | `(params: QueryParams) => QueryResult[]` | Similarity search |

**QueryParams:**
- `vector: number[]` — the query vector
- `topK?: number` — max results to return (default: 10)
- `filter?: (context) => boolean` — pre-scoring filter function

### Embedder (text-based operations)

| Method | Signature | Description |
|--------|-----------|-------------|
| `db.embed(input)` | `(input: string) => Promise<EmbedResult>` | Embed a single string |
| `db.embedMany(input)` | `(input: string[]) => Promise<EmbedResult[]>` | Embed multiple strings |
| `db.addWithText(entry)` | `(entry: TextEntry) => Promise<void>` | Embed text and add entry |
| `db.addManyWithText(entries)` | `(entries: TextEntry[]) => Promise<void>` | Batch embed and add entries |
| `db.queryByText(params)` | `(params: TextQueryParams) => Promise<QueryResult[]>` | Embed query text and search |

All embedder methods throw `TrovecError` if no embedder is configured.

### Serialization

| Method | Signature | Description |
|--------|-----------|-------------|
| `db.serialize()` | `() => Buffer` | Serialize all entries to a binary buffer |
| `db.deserialize(buffer)` | `(buffer: Buffer) => void` | Restore entries from a binary buffer |

### Functional API

Every fluent method is also available as a standalone function that takes the instance as the first argument. This is useful for tree-shaking or when you prefer a functional style:

```typescript
import { create, add, query, close } from '@trovec/core';

const db = await create({ dimensions: 3 });
add(db, { id: 'a', embedding: [1, 2, 3] });
const results = query(db, { vector: [1, 2, 3], topK: 1 });
await close(db);
```

`Trovec` objects are fully compatible with functional functions — you can mix and match both styles.

### Configuration

```typescript
interface TrovecConfig {
  dimensions?: number;                 // auto-resolved from embedder, or required without one
  quantization?: 'F32' | 'INT8' | 'BIT';  // default: 'F32'
  metric?: 'cosine' | 'euclidean' | 'dot' | 'hamming'; // default: 'cosine'
  storageDriver?: StorageDriver;       // default: no-op (in-memory only)
  embedder?: Embedder;                 // default: none (install an adapter)
  collectionId?: string;               // default: auto-generated ('trovec_1', etc.)
  autoFlush?: boolean | number;        // default: true when storageDriver is set
}
```

> **Notes:**
> - When an `embedder` is provided, `dimensions` is automatically resolved from `embedder.dimensions`. You can still set it explicitly, but it must match the embedder's dimensions or an error is thrown.
> - When no `embedder` is provided (raw vector mode), `dimensions` is required.
> - The `hamming` metric requires `BIT` quantization.
> - `autoFlush: true` (default with a storage driver) enables debounced auto-persistence with a 500ms delay. Pass a `number` for a custom delay in ms, or `false` to disable (manual `flush()` only).

## Architecture

```
src/
  index.ts                   Public API barrel export
  types.ts                   All type definitions (including Trovec interface)
  errors.ts                  TrovecError, DimensionMismatchError, InvalidConfigError
  validation.ts              Config/embedding validation, ID serialization
  core.ts                    create(), flush(), stats()
  fluent.ts                  wrapInstance() — binds methods to create the Trovec object
  collection.ts              add(), addMany(), delete(), get()
  query.ts                   Brute-force similarity search
  embedder.ts                Text-based convenience functions (embed, addWithText, queryByText)
  serialization.ts           Binary format for persistence
  quantization/
    index.ts                 Codec dispatcher
    f32.ts                   Float64 passthrough
    int8.ts                  Min-max linear mapping to [-128, 127]
    bit.ts                   Sign-threshold bit packing
  similarity/
    index.ts                 Metric dispatcher
    cosine.ts                dot(a,b) / (||a|| * ||b||)
    euclidean.ts             1 / (1 + distance)
    dot.ts                   Raw dot product
    hamming.ts               Matching bits / total bits
  storage/
    index.ts                 StorageDriver re-export
    memory.ts                In-memory Map-backed driver
    file.ts                  File system driver with Brotli compression
    concurrent-file.ts       Concurrent driver with file locking and optional WAL
    lock.ts                  Advisory file locks with heartbeat and stale detection
    wal.ts                   Write-Ahead Log (append, read, replay)
    crc32.ts                 CRC32 checksums for WAL entry integrity
    encryption.ts            AES-256-GCM encryption primitives and withEncryption() wrapper
```

### How It Works

1. **`create()`** validates configuration, resolves the quantization codec and similarity function once, checks the storage driver for existing data (auto-deserializes if found), and returns a `Trovec` object — the raw instance enriched with bound methods that delegate to the functional implementations (zero logic duplication).

2. **`add()` / `addMany()`** validates embedding dimensions, quantizes the vector through the codec, and stores the quantized representation in a `Map<string, StoredEntry>`. `addMany` validates all entries before mutating any state (atomic semantics).

3. **`query()`** quantizes the query vector, iterates all entries (brute-force), applies the optional filter, computes similarity scores, sorts descending with deterministic tie-breaking (lower ID first), and returns the top-K results.

4. **`get()`** dequantizes the stored vector back to `number[]` before returning, so callers always receive float arrays regardless of the quantization mode.

5. **`flush()`** serializes all entries into a binary buffer and writes it through the `StorageDriver` interface. When auto-flush is enabled, this is called automatically after a debounce delay following mutations. **`close()`** flushes any pending changes, removes the `beforeExit` safety handler, and disables further auto-flush scheduling.

### Internal Precision

All math operations use **float64 precision** internally (`Float64Array`). The quantization type (`F32`, `INT8`, `BIT`) controls storage compression, not computation precision.

### Extensibility

Four extension points are available:

- **`StorageDriver`** — custom persistence backends (see [Custom Storage Drivers](#custom-storage-drivers))
- **`Embedder`** — text-to-vector conversion (see below)
- **`QuantizationCodec`** — implement `encode(embedding) => QuantizedVector` and `decode(quantized) => number[]`
- **`SimilarityFn`** — implement `(a: QuantizedVector, b: QuantizedVector) => number`

### Writing an Embedder Adapter

An embedder adapter is any object that implements the `Embedder` interface:

```typescript
import type { Embedder, EmbedResult } from '@trovec/core';

const DIMENSIONS = 1536; // must match your model's output dimensions

export function createMyEmbedder(options: { apiKey: string }): Embedder {
  return {
    get dimensions() {
      return DIMENSIONS;
    },
    get model() {
      return 'my-model-name'; // optional — useful for logging/diagnostics
    },
    async embed(input: string): Promise<EmbedResult> {
      // Call your embedding API/model here
      const embedding = await callEmbeddingAPI(input, options.apiKey);
      return { embedding };
    },
    async embedMany(inputs: string[]): Promise<EmbedResult[]> {
      // Batch implementation (or loop over embed())
      return Promise.all(inputs.map((input) => this.embed(input)));
    },
  };
}
```

Publish as a separate package (e.g., `@trovec/embedder-mymodel`) to keep Trovec zero-dependency.

## How Persistence Works

When using a storage driver, all data is loaded into memory for querying:

1. **On `create()`**, existing data is automatically read from the storage driver and deserialized into an in-memory `Map`. Use a stable `collectionId` to ensure the same data is loaded across restarts.
2. **Queries** run entirely in-memory via brute-force scan — the storage driver is never touched during search.
3. **Auto-flush** — after each mutation (`add`, `addMany`, `delete`), a debounced timer schedules a `flush()`. Multiple rapid mutations are batched into a single write. A `beforeExit` handler provides a safety net: if the process exits gracefully without an explicit `close()`, pending changes are still persisted.
4. **On `close()`**, any pending changes are flushed immediately, the debounce timer is cleared, and the `beforeExit` handler is removed. Read operations (`get`, `query`, `stats`) continue to work after `close()`.
5. **On `flush()`**, all entries are serialized and written back to storage. Manual `flush()` calls are still supported alongside auto-flush. When using the concurrent file driver with WAL enabled, `flush()` appends only the changed entries to the WAL file instead of rewriting the full collection.

This design keeps queries fast (sub-millisecond for thousands of entries) but means the full dataset must fit in memory.

### Performance at Scale

Operations that touch the full dataset (loading, flushing, reading) scale linearly with collection size. Benchmarks with 128-dimension F32 vectors:

| Entries | Init (`create()`) | Flush | Read | File size | RSS memory |
|---|---|---|---|---|---|
| 1K | 47ms | 32ms | 18ms | 0.9MB | 80MB |
| 10K | 139ms | 110ms | 137ms | 9.3MB | 227MB |
| 100K | 1.4s | 1.1s | 1.5s | 93MB | 888MB |
| 500K | 10s | 7.2s | 13s | 464MB | 3.6GB |
| 1M | 40s | 24s | 51s | 929MB | 7.2GB |

> **Practical comfort zone: up to ~100K entries.** At this size, operations complete in 1-2 seconds, the file is ~93MB, and memory stays under 1GB. Higher dimensions multiply resource usage proportionally (e.g., 100K entries at 384d uses roughly 3x the memory).
>
> With WAL enabled, incremental writes (add + flush) stay under 1ms regardless of collection size — only full-dataset operations scale with entry count.
>
> **With encryption enabled**, flush adds ~30% and read adds ~9% at 100K entries. File sizes are identical (46-byte header is negligible). WAL append overhead is ~13%. See the [encryption docs](../../docs/encryption.md) for detailed benchmarks.
>
> Beyond 100K entries, init and read times grow into the tens of seconds and memory usage reaches multiple gigabytes. Trovec will still function correctly, but the experience degrades significantly. If your dataset is consistently larger than this, consider a database engine designed for large-scale vector storage.

### Future Improvement Considerations

For larger datasets that exceed available memory, several strategies could be explored:

- **Streaming query** — read and score entries in chunks directly from the binary buffer, keeping only the top-K results in a min-heap. Memory usage becomes O(K) instead of O(N).
- **Partitioned storage** — split collections into fixed-size shards (e.g., 10K entries each). Query loads one shard at a time, merging top-K across shards. Memory stays bounded to a single shard.
- **Memory-mapped files** — use `mmap` to map `.trovec` files into virtual address space. The OS pages data in/out on demand, giving near-memory speed for hot data without loading everything.
- **Approximate Nearest Neighbor (ANN) indexing** — replace brute-force with structures like HNSW or IVF that only visit a subset of vectors per query. Index metadata stays in memory while vectors can remain on disk.
- **Hot/cold tiering** — keep recently accessed entries in an LRU cache, everything else on disk. Queries hit the cache first, fall back to disk for misses.

## Development

```bash
npm install          # install dev dependencies
npm test             # run tests (vitest)
npm run test:watch   # run tests in watch mode
npm run test:stress  # run stress, multi-process, and scalability tests
npm run test:bench   # run performance benchmarks
npm run build        # compile to dist/esm + dist/cjs
npm run clean        # remove dist/
```

Stress tests are excluded from `npm test` since they take 1-2 minutes and spawn child processes. See [`tests/storage/__stress__/README.md`](tests/storage/__stress__/README.md) for details.

## License

MIT
