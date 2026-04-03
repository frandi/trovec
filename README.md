# Trovec

A lightweight, zero-dependency vector database ecosystem for Node.js.

## Packages

| Package | Description | npm |
|---------|-------------|-----|
| [`@trovec/core`](packages/core/) | Core vector database library | [![npm](https://img.shields.io/npm/v/@trovec/core)](https://www.npmjs.com/package/@trovec/core) |
| [`@trovec/embedder-local`](packages/embedder-local/) | Zero-dependency local embedder (testing/demos) | [![npm](https://img.shields.io/npm/v/@trovec/embedder-local)](https://www.npmjs.com/package/@trovec/embedder-local) |
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
