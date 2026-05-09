<p align="center">
  <img src="./packages/vscode-trovec/media/icon.png" alt="Trovec" width="128" height="128" />
</p>

# Trovec

A lightweight, zero-dependency vector database ecosystem for Node.js.

## Is Trovec Right for You?

Trovec is designed for applications that need vector search without the overhead of a full database server — think embedded search, local-first apps, CLI tools, prototypes, and small-to-medium production workloads. It runs entirely in-process with zero dependencies.

To help you decide quickly, here's what Trovec handles well and where it isn't the right fit:

**Trovec works great when:**
- Your dataset is up to ~100K entries — operations stay under 2 seconds, memory under 1GB
- You have a handful of concurrent processes (2-10) — the file locking and WAL system handles this cleanly
- You want zero setup — no server, no config, just `npm install` and go
- You need persistence with crash safety — WAL with CRC32 checksums protects your data

**Consider a dedicated vector database when:**
- Your dataset exceeds ~100K entries — at 500K+, init takes 10+ seconds and memory reaches multiple gigabytes (scales linearly with entry count and dimensions)
- You need dozens or hundreds of concurrent writers — Trovec's lock-based concurrency works correctly but tail latency grows into seconds at high contention
- You need sub-millisecond query latency at scale — Trovec uses brute-force search (no ANN indexing yet)

These numbers are from [stress tests](packages/core/tests/storage/__stress__/) on 128-dimension F32 vectors. Higher dimensions (384d, 768d) multiply resource usage proportionally.

We respect your time. If Trovec fits your needs, you get a clean, simple API with no operational overhead. If it doesn't, we'd rather you know that upfront than discover it after integration.

**Where we're headed:** Trovec will stay lightweight and zero-dependency — that's a core principle, not a phase. But we're actively working to push the boundaries of what's practical within that philosophy. Our current target is supporting 1M entries with reasonable memory usage and operation times. If something matters to you, [let us know](https://github.com/frandi/trovec/issues) — user feedback drives what we prioritize.

## Packages

| Package | Description | npm |
|---------|-------------|-----|
| [`@trovec/core`](packages/core/) | Core vector database library | [![npm](https://img.shields.io/npm/v/@trovec/core)](https://www.npmjs.com/package/@trovec/core) |
| [`@trovec/embedder-local`](packages/embedder-local/) | Zero-dependency local embedder (testing/demos) | [![npm](https://img.shields.io/npm/v/@trovec/embedder-local)](https://www.npmjs.com/package/@trovec/embedder-local) |
| [`@trovec/embedder-edge`](packages/embedder-edge/) | Bundled ONNX embedder — real semantic embeddings, fully offline, no setup | [![npm](https://img.shields.io/npm/v/@trovec/embedder-edge)](https://www.npmjs.com/package/@trovec/embedder-edge) |
| [`@trovec/embedder-openai`](packages/embedder-openai/) | OpenAI embeddings adapter | [![npm](https://img.shields.io/npm/v/@trovec/embedder-openai)](https://www.npmjs.com/package/@trovec/embedder-openai) |
| [`@trovec/embedder-ollama`](packages/embedder-ollama/) | Ollama local embeddings adapter | [![npm](https://img.shields.io/npm/v/@trovec/embedder-ollama)](https://www.npmjs.com/package/@trovec/embedder-ollama) |

### Tools

| Package | Description | Install |
|---------|-------------|---------|
| [`@trovec/cli`](packages/cli/) | Command-line interface for trovec | [![npm](https://img.shields.io/npm/v/@trovec/cli)](https://www.npmjs.com/package/@trovec/cli) |
| [Trovec Viewer for VS Code](packages/vscode-trovec/) | VS Code extension for viewing and querying `.trovec` files | [![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/FrandiTech.vscode-trovec)](https://marketplace.visualstudio.com/items?itemName=FrandiTech.vscode-trovec) |

## Quick Start

```bash
# Core library only (bring your own vectors)
npm install @trovec/core

# With local embedder (no API key needed — great for trying out Trovec)
npm install @trovec/core @trovec/embedder-local

# With bundled ONNX embedder (real semantic embeddings, fully offline, no setup)
npm install @trovec/core @trovec/embedder-edge

# With Ollama embeddings (local, no API key needed — requires running Ollama server)
npm install @trovec/core @trovec/embedder-ollama

# With OpenAI embeddings (production-quality semantic search)
npm install @trovec/core @trovec/embedder-openai
```

```typescript
import { create, createFileDriver } from '@trovec/core';

// Persistent storage with Brotli compression (zero-config)
const driver = createFileDriver();

const db = await create({ dimensions: 3, storageDriver: driver });
db.add({ id: 'cat', embedding: [0.9, 0.1, 0.0], context: { type: 'animal' } });
db.add({ id: 'car', embedding: [0.0, 0.1, 0.9], context: { type: 'vehicle' } });

const results = db.query({ vector: [1, 0, 0], topK: 1 });
// [{ id: 'cat', score: 0.993..., context: { type: 'animal' } }]

await db.flush(); // persist to disk
```

For multi-process environments, use the concurrent file driver with file locking and optional WAL:

```typescript
import { create, createConcurrentFileDriver } from '@trovec/core';

const driver = createConcurrentFileDriver({ wal: true });
const db = await create({ dimensions: 3, storageDriver: driver });
```

See each package's README for detailed documentation.

## Repository Structure

```
trovec/
  package.json             Root workspace config (private)
  tsconfig.base.json       Shared TypeScript options
  vitest.config.ts         Runs tests across all packages
  packages/
    core/                  Core library
    embedder-local/        Local embedder (testing/demos)
    embedder-edge/         Bundled ONNX embedder (offline, real semantic embeddings)
    embedder-openai/       OpenAI embeddings adapter
    embedder-ollama/       Ollama local embeddings adapter
    cli/                   Command-line interface
    vscode-trovec/         VS Code extension
    demo/                  Interactive CLI demo
```

This is an npm workspaces monorepo. Each package under `packages/` is published independently to npm.

## Development

```bash
npm install                     # install all workspace dependencies
npm test                        # run all tests across all packages
npm run build --workspaces      # build all packages

# Per-package commands
npm test --workspace=packages/core
npm run build --workspace=packages/embedder-openai
```

## Writing an Adapter

Trovec's `Embedder` interface is the extension point for text-to-vector conversion. See the [adapter guide](packages/core/README.md#writing-an-embedder-adapter) in the core README or use `@trovec/embedder-openai` as a reference implementation.

## License

MIT
