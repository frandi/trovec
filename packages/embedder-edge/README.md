<p align="center">
  <img src="./icon.png" alt="Trovec" width="128" height="128" />
</p>

# @trovec/embedder-edge

[![npm](https://img.shields.io/npm/v/@trovec/embedder-edge)](https://www.npmjs.com/package/@trovec/embedder-edge)

Bundled real-model text embedder for [Trovec](../core/README.md). Runs a
quantized [bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5)
ONNX model in-process via `onnxruntime-node`. **No API keys, no Ollama
server, no network calls at runtime** — install once and you have
production-quality semantic search that works fully offline.

On a recent benchmark of 480 paraphrased queries against an 80-page
English PDF, this default model hits **53.3% recall@1 at 12 ms median
latency** — within ~3 percentage points of OpenAI's `text-embedding-3-small`
on quality, while being **~32× faster** at query time and running fully
offline. See [`poc/pdf-rag/BENCHMARK.md`](../../poc/pdf-rag/BENCHMARK.md)
for the full multi-model comparison and methodology.

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
| **Production semantic search, offline, low query latency** | **`@trovec/embedder-edge`** |
| Larger local models with their own server, multilingual options | [`@trovec/embedder-ollama`](../embedder-ollama/) |
| Bulk-ingest huge corpora fast, or multilingual content | [`@trovec/embedder-openai`](../embedder-openai/) |

For chat-with-documents on small-to-medium English corpora, this package
is competitive with cloud embedders on retrieval quality and substantially
faster at query time. For high-precision retrieval workloads, point
`modelPath` at `bge-base-en-v1.5` or `bge-large-en-v1.5` weights — both
beat `text-embedding-3-small` on retrieval quality at ~110 MB / ~336 MB
respectively. See [Loading other models](#loading-other-models) below.

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
  model?: 'bge-small-en-v1.5',  // default; only known model in v0.x
  modelPath?: string,            // override the bundled assets directory
  preload?: boolean,             // load the ONNX session eagerly (default: false)
  tokenizer?: Tokenizer,         // custom tokenizer (e.g. SentencePiece) — see below
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

## Loading other models

The bundled model is `bge-small-en-v1.5`. If you want a different
BERT-WordPiece compatible model — e.g., `bge-base-en-v1.5`,
`bge-large-en-v1.5`, `all-MiniLM-L6-v2`, `gte-small` — download the
ONNX file and `tokenizer.json` into a directory and point `modelPath`
at it:

```typescript
import { createEdgeEmbedder } from '@trovec/embedder-edge';

const embedder = createEdgeEmbedder({
  modelPath: '/path/to/bge-base-en-v1.5',  // contains onnx/model_int8.onnx + tokenizer.json
});
```

The directory must contain:
- An ONNX file at the path matching the model spec's `onnxFile` (default `onnx/model_int8.onnx`).
- A `tokenizer.json` in HuggingFace format.

Note that the bundled model registry inside this package only knows
about `bge-small-en-v1.5`. To use other models, you'll typically also
want to compose your own embedder from the package's lower-level
exports (see below) so you can pin custom dimensions, max-token limits,
and weight version strings.

## Custom tokenizers (SentencePiece, BPE, etc.)

The default tokenizer is BERT WordPiece, loaded from `tokenizer.json`
in the model directory. To use a different tokenizer family — for
multilingual models like `bge-m3` or `multilingual-e5-*` that use
SentencePiece — implement the `Tokenizer` interface and pass it via
the `tokenizer` option:

```typescript
import { createEdgeEmbedder, type Tokenizer } from '@trovec/embedder-edge';

const myTokenizer: Tokenizer = {
  encode(text, opts) { /* ... */ },
  encodeBatch(texts, opts) { /* ... */ },
  spec: { /* ... */ },
};

const embedder = createEdgeEmbedder({
  modelPath: '/path/to/multilingual-model',
  tokenizer: myTokenizer,
});
```

The tokenizer must produce the standard BERT-style ONNX feeds
(`input_ids`, `attention_mask`, `token_type_ids`). Models that require
different feed structures (e.g., XLM-R variants without
`token_type_ids`) are not supported through this option alone — those
need a custom inference path built from the package's lower-level
exports (`loadOnnxSession`, `runInference`, `meanPoolAndNormalize`).

## Low-level exports

For advanced composition — benchmarking multiple models, building a
custom inference path, or shipping a community tokenizer package — the
runtime building blocks are public:

```typescript
import {
  loadOnnxSession,
  runInference,
  meanPoolAndNormalize,
  createTokenizer,
  loadTokenizer,
  type Tokenizer,
  type TokenizerJson,
  type ModelSpec,
  type OnnxSession,
} from '@trovec/embedder-edge';
```

These are the same primitives the high-level `createEdgeEmbedder`
factory uses. They're stable across minor versions; reach for them
only when the high-level API doesn't fit.

## Performance characteristics

These are rough numbers on a typical laptop CPU running the bundled
default model (`bge-small-en-v1.5` INT8). Real numbers depend on
hardware and input length.

| Metric | Value |
|---|---|
| Resident memory | ~50–150 MB (bundled model) |
| Cold-start (first `embed()` call) | 100–500 ms |
| Steady-state single embed | ~12 ms (single-call), 8 ms with smaller MiniLM |
| Throughput @ batch=32 (varied length) | ~4–8 chunks/sec |
| Tarball install size | ~22 MB compressed / ~35 MB unpacked |

For larger models loaded via `modelPath`:
- `bge-base-en-v1.5` INT8 (~110 MB): ~29 ms p50 latency, recall@1 58.1%
- `bge-large-en-v1.5` INT8 (~336 MB): ~93 ms p50 latency, recall@1 59.8%

## Limitations

- **English only.** The bundled `bge-small-en-v1.5` is an English model.
  Multilingual models exist (bge-m3, multilingual-e5-*) but use
  SentencePiece tokenization — you can plug those in via the `tokenizer`
  option above, but a SentencePiece TS implementation isn't shipped
  with this package.
- **Node only in v0.x.** Browser support requires `onnxruntime-web`;
  not yet shipped.
- **Single bundled model.** Other models can be loaded via `modelPath`
  pointing at a compatible ONNX directory, but only `bge-small-en-v1.5`
  ships in the tarball.
- **No `embed-with-prefix` helpers.** bge models recommend a query prefix
  ("Represent this sentence for searching relevant passages: ") for
  search queries. v0.x does not auto-apply it; pass it in your input
  string if you want the small quality boost it offers.

## License

MIT. Bundles model weights derived from `BAAI/bge-small-en-v1.5` (also
MIT-licensed). See `models/bge-small-en-v1.5/NOTICE.md` for attribution
and source pin details.
