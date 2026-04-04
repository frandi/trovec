<p align="center">
  <img src="./icon.png" alt="Trovec" width="128" height="128" />
</p>

# @trovec/embedder-ollama

[![npm](https://img.shields.io/npm/v/@trovec/embedder-ollama)](https://www.npmjs.com/package/@trovec/embedder-ollama)

Ollama embeddings adapter for [Trovec](../core/README.md). Converts text to vector embeddings using a locally running [Ollama](https://ollama.com/) server.

Zero runtime dependencies — uses Node.js 18+ built-in `fetch`. No API key required.

## Prerequisites

A running Ollama server with an embedding model pulled. See the [Ollama setup guide](../../docs/ollama.md) for Docker-based setup, or install Ollama directly:

```bash
ollama pull nomic-embed-text
```

## Installation

```bash
npm install @trovec/core @trovec/embedder-ollama
```

## Usage

```typescript
import { create, addWithText, queryByText } from '@trovec/core';
import { createOllamaEmbedder } from '@trovec/embedder-ollama';

const db = await create({
  embedder: createOllamaEmbedder(),
});
// dimensions are automatically resolved from the embedder (768 for the default model)

await addWithText(db, { id: 'doc1', text: 'The cat sat on the mat' });
await addWithText(db, { id: 'doc2', text: 'Dogs love to play fetch' });

const results = await queryByText(db, { text: 'animals sitting', topK: 5 });
```

## Options

```typescript
createOllamaEmbedder({
  model?: string;        // default: 'nomic-embed-text'
  baseUrl?: string;      // default: 'http://localhost:11434'
  dimensions?: number;   // auto-resolved for known models; required for custom models
})
```

All options are optional — the defaults work out of the box with a standard Ollama installation. The returned embedder exposes read-only `dimensions` and `model` properties. Trovec uses `dimensions` to auto-configure itself; `model` is available for logging and diagnostics.

### Models

| Model | Dimensions | Size | Notes |
|-------|-----------|------|-------|
| `nomic-embed-text` | 768 | ~274 MB | Default, good quality for general use |
| `mxbai-embed-large` | 1024 | ~670 MB | Higher quality, larger model |
| `all-minilm` | 384 | ~45 MB | Lightweight, fast |

Browse more embedding models at [ollama.com/search?c=embedding](https://ollama.com/search?c=embedding).

For models not in the list above, pass `dimensions` explicitly:

```typescript
createOllamaEmbedder({
  model: 'custom-model',
  dimensions: 512,
})
```

### Remote Server

Use `baseUrl` to point to an Ollama instance on another machine:

```typescript
createOllamaEmbedder({
  baseUrl: 'http://192.168.1.100:11434',
})
```

## License

MIT
