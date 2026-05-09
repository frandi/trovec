<p align="center">
  <img src="./icon.png" alt="Trovec" width="128" height="128" />
</p>

# @trovec/embedder-edge

[![npm](https://img.shields.io/npm/v/@trovec/embedder-edge)](https://www.npmjs.com/package/@trovec/embedder-edge)

Bundled real-model text embedder for [Trovec](../core/README.md). Runs the
quantized [bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5)
ONNX model in-process via `onnxruntime-node`. **No API keys, no Ollama
server, no network calls at runtime** — install once and you have
production-quality semantic search that works fully offline.

> **Dependency note:** Unlike `@trovec/core`, this package is **not**
> zero-dependency. It depends on `onnxruntime-node` (which ships native
> prebuilds) and bundles an INT8 quantized ONNX model. The npm tarball
> is ~22 MB compressed and unpacks to ~35 MB on disk. The Trovec core
> remains zero-dependency; this adapter accepts that cost in exchange
> for production-quality offline embeddings.

## When to use this vs the other adapters

| You want… | Use |
|---|---|
| To learn the API or write tests | [`@trovec/embedder-local`](../embedder-local/) |
| **Production semantic search with no setup, fully offline** | **`@trovec/embedder-edge`** |
| Larger local models, willing to run an Ollama server | [`@trovec/embedder-ollama`](../embedder-ollama/) |
| Top-tier cloud quality, OK with API costs | [`@trovec/embedder-openai`](../embedder-openai/) |

## Installation

```bash
npm install @trovec/core @trovec/embedder-edge
```

The package tarball is ~22 MB compressed and unpacks to ~35 MB on disk
because it bundles the model weights. There are no further setup steps
— the model is ready to use immediately after install.

## Usage

```typescript
import { create, addWithText, queryByText } from '@trovec/core';
import { createEdgeEmbedder } from '@trovec/embedder-edge';

const db = await create({
  embedder: createEdgeEmbedder(),
});
// dimensions auto-resolved from the embedder (384)

await addWithText(db, { id: 'doc1', text: 'Cats are curious animals' });
await addWithText(db, { id: 'doc2', text: 'Dogs love to play fetch' });
await addWithText(db, { id: 'doc3', text: 'TypeScript adds static typing' });

const results = await queryByText(db, { text: 'pets and animals', topK: 2 });
// Returns doc1 and doc2 (animal-related documents rank higher)
```

## Options

```typescript
createEdgeEmbedder({
  model?: 'bge-small-en-v1.5',  // default; only known model in v0.1.0
  modelPath?: string,            // override the bundled assets directory
  preload?: boolean,             // load the ONNX session eagerly (default: false)
})
```

The returned embedder exposes read-only `dimensions` and `model` properties.
`model` returns `"bge-small-en-v1.5@1.0.0"` — the version suffix is the
embedder weight version, not the npm package version, and triggers Trovec's
mismatch warning if a collection is loaded with a different embedder.

### Lazy loading

The factory returns immediately. The ONNX session is loaded on the first
`embed()` or `embedMany()` call (typically 100–500 ms). Pass `preload: true`
to load eagerly during factory creation.

## Performance characteristics

These are rough numbers on a typical laptop CPU. Real numbers depend on
hardware and input length.

| Metric | Value |
|---|---|
| Resident memory | ~150–200 MB |
| Cold-start (first `embed()` call) | 100–500 ms |
| Steady-state single embed | 5–30 ms |
| Steady-state batch of 10 | 30–100 ms (sub-linear) |
| Tarball (compressed / unpacked) | ~22 MB / ~35 MB |

## Quality

Uses the INT8 quantized variant of bge-small-en-v1.5 from the
[`Xenova/bge-small-en-v1.5`](https://huggingface.co/Xenova/bge-small-en-v1.5)
mirror. Quality drop versus the full-precision model is typically
0.5–1.5 percentage points on MTEB retrieval benchmarks — generally
imperceptible for chat-with-documents use cases.

For benchmarking-grade quality, point `modelPath` at a full-precision
ONNX file you supply yourself.

## Limitations in v0.1.0

- **English only.** bge-small-en-v1.5 is an English model. Multilingual
  variants exist but are 4× larger.
- **Node only.** Browser support requires `onnxruntime-web`; not yet
  shipped.
- **Single bundled model.** Other models can be loaded via `modelPath`
  pointing at a compatible ONNX directory, but only `bge-small-en-v1.5`
  is bundled.
- **No `embed-with-prefix` helpers.** bge models recommend a query prefix
  ("Represent this sentence for searching relevant passages: ") for
  search queries. v0.1.0 does not auto-apply it; pass it in your input
  string if you want the small quality boost it offers.

## License

MIT. Bundles model weights derived from `BAAI/bge-small-en-v1.5` (also
MIT-licensed). See `models/bge-small-en-v1.5/NOTICE.md` for attribution
and source pin details.
