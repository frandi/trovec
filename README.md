# VCore

A lightweight, zero-dependency vector database ecosystem for Node.js.

## Packages

| Package | Description | npm |
|---------|-------------|-----|
| [`vcore`](packages/vcore/) | Core vector database library | [![npm](https://img.shields.io/npm/v/vcore)](https://www.npmjs.com/package/vcore) |
| [`vcore-embedder-local`](packages/vcore-embedder-local/) | Zero-dependency local embedder (testing/demos) | [![npm](https://img.shields.io/npm/v/vcore-embedder-local)](https://www.npmjs.com/package/vcore-embedder-local) |
| [`vcore-embedder-openai`](packages/vcore-embedder-openai/) | OpenAI embeddings adapter | [![npm](https://img.shields.io/npm/v/vcore-embedder-openai)](https://www.npmjs.com/package/vcore-embedder-openai) |
| [`vcore-embedder-ollama`](packages/vcore-embedder-ollama/) | Ollama local embeddings adapter | [![npm](https://img.shields.io/npm/v/vcore-embedder-ollama)](https://www.npmjs.com/package/vcore-embedder-ollama) |

## Quick Start

```bash
# Core library only (bring your own vectors)
npm install vcore

# With local embedder (no API key needed — great for trying out VCore)
npm install vcore vcore-embedder-local

# With Ollama embeddings (local, no API key needed — requires running Ollama server)
npm install vcore vcore-embedder-ollama

# With OpenAI embeddings (production-quality semantic search)
npm install vcore vcore-embedder-openai
```

```typescript
import { create, add, query } from 'vcore';

const db = create({ dimensions: 3 });
add(db, { id: 'cat', embedding: [0.9, 0.1, 0.0], context: { type: 'animal' } });
add(db, { id: 'car', embedding: [0.0, 0.1, 0.9], context: { type: 'vehicle' } });

const results = query(db, { vector: [1, 0, 0], topK: 1 });
// [{ id: 'cat', score: 0.993..., context: { type: 'animal' } }]
```

See each package's README for detailed documentation.

## Repository Structure

```
vcore/
  package.json             Root workspace config (private)
  tsconfig.base.json       Shared TypeScript options
  vitest.config.ts         Runs tests across all packages
  packages/
    vcore/                 Core library
    vcore-embedder-local/  Local embedder (testing/demos)
    vcore-embedder-openai/ OpenAI embeddings adapter
    vcore-embedder-ollama/ Ollama local embeddings adapter
    demo/                  Interactive CLI demo
```

This is an npm workspaces monorepo. Each package under `packages/` is published independently to npm.

## Development

```bash
npm install                     # install all workspace dependencies
npm test                        # run all tests across all packages
npm run build --workspaces      # build all packages

# Per-package commands
npm test --workspace=packages/vcore
npm run build --workspace=packages/vcore-embedder-openai
```

## Writing an Adapter

VCore's `Embedder` interface is the extension point for text-to-vector conversion. See the [adapter guide](packages/vcore/README.md#writing-an-embedder-adapter) in the core README or use `vcore-embedder-openai` as a reference implementation.

## License

MIT
