# @trovec/core

A lightweight, zero-dependency vector database library for Node.js. Store, query, and persist vector embeddings with support for multiple quantization types and similarity metrics.

Built to the [Trovec Specification (VCS-1) v1.0.1](docs/spec.md).

## Features

- **Zero runtime dependencies** — only Node.js required
- **Multiple quantization modes** — F32 (full precision), INT8 (compressed), BIT (binary)
- **Four similarity metrics** — Cosine, Euclidean, Dot Product, Hamming
- **Functional API** — stateless functions, no classes, fully tree-shakeable
- **Dual ESM/CJS** — works with both `import` and `require`
- **TypeScript-first** — full type definitions included
- **Mixed ID types** — supports both `string` and `bigint` entry IDs
- **Pluggable Embedder** — bring your own embedding adapter for text-to-vector conversion

## Quick Start

### Installation

```bash
npm install @trovec/core
```

### Basic Usage

```typescript
import { create, add, query } from '@trovec/core';

// 1. Create an instance
const db = create({ dimensions: 3 });

// 2. Add entries
add(db, { id: 'cat', embedding: [0.9, 0.1, 0.0], context: { type: 'animal' } });
add(db, { id: 'dog', embedding: [0.8, 0.2, 0.0], context: { type: 'animal' } });
add(db, { id: 'car', embedding: [0.0, 0.1, 0.9], context: { type: 'vehicle' } });

// 3. Query for similar vectors
const results = query(db, { vector: [1, 0, 0], topK: 2 });

console.log(results);
// [
//   { id: 'cat', score: 0.993..., context: { type: 'animal' } },
//   { id: 'dog', score: 0.970..., context: { type: 'animal' } }
// ]
```

### With Quantization and Filtering

```typescript
import { create, addMany, query } from '@trovec/core';

const db = create({
  dimensions: 128,
  quantization: 'INT8',    // compress vectors to int8
  metric: 'euclidean',
});

// Batch insert
addMany(db, [
  { id: 1n, embedding: new Array(128).fill(0.5), context: { category: 'A' } },
  { id: 2n, embedding: new Array(128).fill(0.3), context: { category: 'B' } },
  { id: 3n, embedding: new Array(128).fill(0.7), context: { category: 'A' } },
]);

// Query with filter
const results = query(db, {
  vector: new Array(128).fill(0.6),
  topK: 5,
  filter: (ctx) => ctx?.category === 'A',
});
```

### Persistence

```typescript
import { create, add, flush, deserialize } from '@trovec/core';
import { createMemoryDriver } from '@trovec/core';

const driver = createMemoryDriver();
const db = create({ dimensions: 3, storageDriver: driver });

add(db, { id: 'a', embedding: [1, 2, 3] });

// Persist to storage
await flush(db);

// Later: restore into a new instance
const db2 = create({ dimensions: 3, storageDriver: driver });
const buffer = await driver.read(db.collectionId);
if (buffer) deserialize(buffer, db2);
```

### Text Embedding (with adapter)

Trovec provides an `Embedder` interface for text-to-vector conversion. Install an adapter package, then use text-based convenience functions:

```typescript
import { create, addWithText, queryByText } from '@trovec/core';
import { createOpenAIEmbedder } from '@trovec/embedder-openai'; // adapter package

const db = create({
  dimensions: 1536,
  embedder: createOpenAIEmbedder({ apiKey: process.env.OPENAI_API_KEY }),
});

// Add entries using text — embedding happens automatically
await addWithText(db, { id: 'doc1', text: 'The cat sat on the mat', context: { source: 'book' } });
await addWithText(db, { id: 'doc2', text: 'Dogs love to play fetch' });

// Query using text
const results = await queryByText(db, { text: 'animals sitting', topK: 5 });
```

> **No built-in embedder is included** — this keeps Trovec zero-dependency. Available adapters:
>
> | Adapter | Dimensions | Notes |
> |---------|-----------|-------|
> | [`@trovec/embedder-local`](../embedder-local/) | 64 | Trigram hash, zero deps, offline — for testing/demos |
> | [`@trovec/embedder-ollama`](../embedder-ollama/) | 768 | Local Ollama server, no API key — good semantic quality |
> | [`@trovec/embedder-openai`](../embedder-openai/) | 1536 | OpenAI API — best semantic quality |
>
> See [Writing an Embedder Adapter](#writing-an-embedder-adapter) below for how to create your own.

## API Reference

### Lifecycle

| Function | Signature | Description |
|----------|-----------|-------------|
| `create` | `(config: TrovecConfig) => TrovecInstance` | Create a new instance |
| `flush` | `(instance: TrovecInstance) => Promise<void>` | Persist all data to storage |
| `stats` | `(instance: TrovecInstance) => TrovecStats` | Get instance statistics |

### Collection Operations

| Function | Signature | Description |
|----------|-----------|-------------|
| `add` | `(instance, entry: Entry) => void` | Insert or replace an entry |
| `addMany` | `(instance, entries: Entry[]) => void` | Atomic batch insert (all-or-nothing) |
| `delete` | `(instance, id: EntryId) => boolean` | Remove an entry, returns `true` if it existed |
| `get` | `(instance, id: EntryId) => Entry \| undefined` | Retrieve an entry by ID |

### Query

| Function | Signature | Description |
|----------|-----------|-------------|
| `query` | `(instance, params: QueryParams) => QueryResult[]` | Similarity search |

**QueryParams:**
- `vector: number[]` — the query vector
- `topK?: number` — max results to return (default: 10)
- `filter?: (context) => boolean` — pre-scoring filter function

### Embedder (text-based operations)

| Function | Signature | Description |
|----------|-----------|-------------|
| `embed` | `(instance, input: string) => Promise<EmbedResult>` | Embed a single string |
| `embedMany` | `(instance, input: string[]) => Promise<EmbedResult[]>` | Embed multiple strings |
| `addWithText` | `(instance, entry: TextEntry) => Promise<void>` | Embed text and add entry |
| `addManyWithText` | `(instance, entries: TextEntry[]) => Promise<void>` | Batch embed and add entries |
| `queryByText` | `(instance, params: TextQueryParams) => Promise<QueryResult[]>` | Embed query text and search |

All functions throw `TrovecError` if no embedder is configured.

### Configuration

```typescript
interface TrovecConfig {
  dimensions: number;                  // required: vector dimensionality
  quantization?: 'F32' | 'INT8' | 'BIT';  // default: 'F32'
  metric?: 'cosine' | 'euclidean' | 'dot' | 'hamming'; // default: 'cosine'
  storageDriver?: StorageDriver;       // default: no-op (in-memory only)
  embedder?: Embedder;                 // default: none (install an adapter)
}
```

> **Note:** The `hamming` metric requires `BIT` quantization.

## Architecture

```
src/
  index.ts                   Public API barrel export
  types.ts                   All type definitions
  errors.ts                  TrovecError, DimensionMismatchError, InvalidConfigError
  validation.ts              Config/embedding validation, ID serialization
  core.ts                    create(), flush(), stats()
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
```

### How It Works

1. **`create()`** validates configuration, resolves the quantization codec and similarity function once, and returns an instance holding an empty entry map.

2. **`add()` / `addMany()`** validates embedding dimensions, quantizes the vector through the codec, and stores the quantized representation in a `Map<string, StoredEntry>`. `addMany` validates all entries before mutating any state (atomic semantics).

3. **`query()`** quantizes the query vector, iterates all entries (brute-force), applies the optional filter, computes similarity scores, sorts descending with deterministic tie-breaking (lower ID first), and returns the top-K results.

4. **`get()`** dequantizes the stored vector back to `number[]` before returning, so callers always receive float arrays regardless of the quantization mode.

5. **`flush()`** serializes all entries into a binary buffer and writes it through the `StorageDriver` interface.

### Internal Precision

All math operations use **float64 precision** internally (`Float64Array`). The quantization type (`F32`, `INT8`, `BIT`) controls storage compression, not computation precision.

### Extensibility

Three extension points are available:

- **`Embedder`** — text-to-vector conversion (see below)
- **`QuantizationCodec`** — implement `encode(embedding) => QuantizedVector` and `decode(quantized) => number[]`
- **`SimilarityFn`** — implement `(a: QuantizedVector, b: QuantizedVector) => number`

### Writing an Embedder Adapter

An embedder adapter is any object that implements the `Embedder` interface:

```typescript
import type { Embedder, EmbedResult } from '@trovec/core';

export function createMyEmbedder(options: { apiKey: string }): Embedder {
  return {
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

## Development

```bash
npm install          # install dev dependencies
npm test             # run tests (vitest)
npm run test:watch   # run tests in watch mode
npm run build        # compile to dist/esm + dist/cjs
npm run clean        # remove dist/
```

## License

MIT
