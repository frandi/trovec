# PDF RAG POC

A proof-of-concept demonstrating [Trovec](https://www.npmjs.com/package/@trovec/core) for Retrieval-Augmented Generation (RAG) over PDF documents. Upload a PDF, ask natural language questions, and get cited answers grounded in the document content.

This directory now hosts two related things:

1. **The demo app** — an Express server with a single-page UI. Defaults to running with `@trovec/embedder-edge` so it works offline without API keys for ingest and search; OpenAI is needed only for LLM-generated answers.
2. **The embedder benchmark** — a head-to-head comparison of `embedder-edge` (multiple ONNX models) against `embedder-openai` on a fixed English corpus. See [`BENCHMARK.md`](./BENCHMARK.md) for results, methodology, and scenario-based recommendations.

## How It Works

```
PDF Upload ──> LiteParse (extract text per page)
           ──> Paragraph-level chunking (100-500 chars)
           ──> Embeddings (default: bge-base-en-v1.5 via @trovec/embedder-edge,
                            batched to bound peak memory)
           ──> Trovec vector store (cosine similarity, file-backed,
                                    one collection file per embedder dimension)

Question   ──> Trovec semantic search (top-K chunks)
           ──> OpenAI chat completion (synthesize answer with citations)
           ──> Cited answer + source references
```

### Key Components

| Component | Library | Purpose |
|-----------|---------|---------|
| Vector store | `@trovec/core` | Store and query document embeddings (concurrent-safe file storage with optional AES-256-GCM encryption at rest) |
| Embeddings | `@trovec/embedder-edge` (default, `bge-base-en-v1.5`) or `@trovec/embedder-openai` | Generate vectors locally (offline, ~29 ms p50) or via cloud API |
| PDF parsing | `@llamaindex/liteparse` | Extract text with page-level structure |
| Answer generation | `openai` chat completions | Synthesize cited answers from retrieved chunks |
| Web server | `express` | API endpoints + static file serving |

### RAG Pipeline Details

**Ingestion:**
- LiteParse extracts text per page from the uploaded PDF
- Each page is split into paragraph-level chunks (100-500 chars) for more focused embeddings
- Chunks are embedded in fixed-size batches (32 per ONNX inference call) so peak memory stays bounded even for hundred-page PDFs. The server logs `[ingest] <file>: embedded N/M chunks` between batches.
- Each chunk stores metadata: page number, source file, full text, and a short preview
- Data is persisted via Trovec's **concurrent file storage driver** (`createConcurrentFileDriver`), which uses a write-ahead log and OS-level file locking so multiple ingest requests can write safely in parallel. The collection file name is dimension-aware (`.trovec/trovec-<dim>d.trovec`), so switching embedders never corrupts the previous data — both files coexist on disk.
- Optionally wrapped with **`withEncryption`** for transparent AES-256-GCM encryption at rest

**Retrieval:**
- Trovec performs brute-force cosine similarity search across all stored chunks
- Top-K most relevant chunks are returned with similarity scores

**Answer Generation:**
- Retrieved chunks (full text, not truncated) are sent to OpenAI as numbered sources
- Anti-hallucination prompt enforces: cite every claim, no outside knowledge, admit gaps
- Only citations actually referenced in the answer are returned to the UI
- LLM token usage (model, input/output tokens) is displayed for transparency

## Prerequisites

- **Node.js** ≥ 18
- **OpenAI API key** — *only* required for `/api/ask` (the LLM answer-generation step). Ingest, `/api/search`, and `/api/documents` work without one.

## Getting Started

```bash
cd poc/pdf-rag
npm install

# One-time fetch of the default bge-base ONNX weights (~110 MB, gitignored, SHA256-verified).
# Skip this step if you set EDGE_MODEL=bge-small-en-v1.5 (bundled with the package).
SKIP_OPENAI=1 BENCH_MODEL_FILTER=bge-base-en-v1.5 npm run benchmark

npm start
```

Open http://localhost:3737. Upload a PDF, then either:

- Use the search panel directly — works without an API key.
- For cited LLM answers, drop an `OPENAI_API_KEY=sk-...` into a `.env` file and restart.

The first request triggers a one-time ONNX session load (~500 ms–1 s for bge-base; ~100–500 ms for bge-small). Subsequent requests are steady-state (~29 ms median per query for bge-base, ~12 ms for bge-small, on a typical laptop).

## Embedder choice

The default is `@trovec/embedder-edge` with **`bge-base-en-v1.5`** (offline, in-process, ~110 MB INT8 ONNX). On the NIST benchmark it beats `text-embedding-3-small` on retrieval quality (58.1% vs 56.7% recall@1) while staying fully offline.

`bge-base` is **not** shipped in the `@trovec/embedder-edge` tarball (the package only bundles `bge-small`). The POC auto-resolves it from `./bench-models/bge-base-en-v1.5/`, which `npm run benchmark` populates on first run (gitignored, SHA256-verified). One-time setup:

```bash
SKIP_OPENAI=1 BENCH_MODEL_FILTER=bge-base-en-v1.5 npm run benchmark
```

Then start the server normally:

```bash
npm start
```

To use a different model, set `EDGE_MODEL`:

```bash
EDGE_MODEL=bge-small-en-v1.5 npm start   # smaller, bundled with the package, no setup
EDGE_MODEL=bge-large-en-v1.5 npm start   # higher quality, requires bench-models fetch
EMBEDDER=openai npm start                # switch to OpenAI embeddings
```

Trade-offs on the NIST benchmark (see [`BENCHMARK.md`](./BENCHMARK.md)):

| | `bge-small` (bundled) | `bge-base` (default) | `bge-large` | `EMBEDDER=openai` |
|---|---|---|---|---|
| Setup | None — bundled | One-time bench fetch (~110 MB) | One-time bench fetch (~336 MB) | `OPENAI_API_KEY` |
| Network | None for embedding | None for embedding | None for embedding | Required |
| Quality (recall@1) | 53.3% | **58.1%** | **59.8%** | 56.7% |
| Query latency (p50) | ~12 ms | ~29 ms | ~93 ms | ~400 ms |
| Ingest throughput | ~8 chunks/s | ~3 chunks/s | ~0.8 chunks/s | ~37 chunks/s |
| Per-call cost | $0 | $0 | $0 | per-token |

> **Switching embedders is safe.** Each embedder writes to its own dimension-keyed collection file (`.trovec/trovec-<dim>d.trovec`), so prior data is never overwritten or corrupted. When the server detects documents indexed by a previous embedder, the UI shows a yellow "rebuild needed" banner with a one-click re-ingest action (`POST /api/rebuild`). No need to delete `.trovec/`.

## Usage

The UI is split into two panels:

- **Left panel** — Upload PDFs and browse the document list. Each document can be deleted, which removes its vectors, metadata record, and uploaded file.
- **Right panel** — Ask natural language questions and review cited answers with expandable source references (requires `OPENAI_API_KEY`).

Ingested data is persisted in the `.trovec` directory, so previously uploaded documents are available across restarts.

## Benchmark

The same corpus + Trovec setup is used to compare embedder choices side-by-side. Run:

```bash
OPENAI_API_KEY=sk-... npm run benchmark
```

First run auto-fetches the test PDF (NIST SP 800-63B, public domain, English) and the bench-only ONNX weights for bge-small / bge-base / bge-large / all-MiniLM-L6-v2 (~470 MB total, gitignored, SHA256-verified). Subsequent runs reuse the cache.

Output: per-query results in `BENCHMARK_RESULTS.json` (gitignored), and a markdown summary printed to stdout. The committed report at [`BENCHMARK.md`](./BENCHMARK.md) is a written-up snapshot of one such run.

Useful env vars:

| Variable | Effect |
|---|---|
| `SKIP_OPENAI=1` | Run only the local edge models (no API key needed) |
| `BENCH_MODEL_FILTER=bge-small-en-v1.5,bge-base-en-v1.5` | Subset of models to run |
| `BENCH_REGENERATE_QUERIES=1` | Regenerate the LLM-paraphrased query cache (requires `OPENAI_API_KEY`) |
| `BENCH_BATCH_SIZES=1,10,100` | Throughput micro-bench batch sizes |

See `src/benchmark.ts` and `src/bench/` for implementation; full methodology in `BENCHMARK.md`.

## Configuration

Environment variables (can be set in `.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3737` | Server port |
| `EMBEDDER` | `edge` | Embedder backend: `edge` (local ONNX, offline) or `openai` (cloud API) |
| `EDGE_MODEL` | `bge-base-en-v1.5` | Edge model id. `bge-small-en-v1.5` is bundled with `@trovec/embedder-edge`; `bge-base-en-v1.5` and `bge-large-en-v1.5` are auto-resolved from `./bench-models/<id>/` (populated by `npm run benchmark`) |
| `OPENAI_API_KEY` | *(empty)* | Required for `/api/ask` answer generation; also required when `EMBEDDER=openai` |
| `TROVEC_ENCRYPTION_KEY` | *(optional)* | 64-char hex string (32 raw bytes) — enables AES-256-GCM encryption at rest using a raw key |
| `TROVEC_ENCRYPTION_PASSWORD` | *(optional)* | Passphrase — enables AES-256-GCM encryption at rest using a PBKDF2-derived key. Ignored if `TROVEC_ENCRYPTION_KEY` is set |

### Generating an encryption key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Save the output as `TROVEC_ENCRYPTION_KEY` in your `.env`. **Losing the key means losing the data** — there is no recovery path.

> **Already have a plaintext `.trovec/` directory from a previous run?** You can't just set `TROVEC_ENCRYPTION_KEY` — the server will fail to start with an `EncryptionError`. Instead, follow the [encryption-at-rest migration guide](../../docs/migration/encryption-at-rest.md), which uses this POC as the worked example.

## API Endpoints

| Method | Path | Description | Needs `OPENAI_API_KEY`? |
|--------|------|-------------|---|
| `POST` | `/api/ingest` | Upload and ingest a PDF (multipart form, field: `pdf`) | Only with `EMBEDDER=openai` |
| `GET` | `/api/documents` | List all ingested documents | No |
| `DELETE` | `/api/documents/:fileName` | Delete a document (vectors, record, and uploaded file) | No |
| `GET` | `/api/search?q=...&topK=5` | Raw semantic search (returns ranked chunks) | Only with `EMBEDDER=openai` |
| `POST` | `/api/ask` | Ask a question, get a cited answer (JSON body: `{ question, topK? }`) | **Yes — always** (uses LLM) |
| `GET` | `/api/status` | Vector store stats (entry count, dimensions, metric) | No |
| `GET` | `/api/rebuild-status` | Reports documents whose entries live in a different collection (e.g., after switching `EDGE_MODEL`) and still have their uploaded file on disk | No |
| `POST` | `/api/rebuild` | Re-ingest all pending documents through the currently-active embedder. Synchronous; may take minutes on CPU inference for large corpora | Only with `EMBEDDER=openai` |

## Project Structure

```
poc/pdf-rag/
├── .env                       # Environment variables (not committed)
├── .trovec/                   # Persisted vector store + document registry (auto-created; one `trovec-<dim>d.trovec` per embedder dimension)
├── package.json
├── tsconfig.json
├── BENCHMARK.md               # Embedder comparison report (committed)
├── BENCHMARK_RESULTS.json     # Latest raw benchmark output (gitignored)
├── bench-queries.json         # LLM-paraphrased query cache (gitignored)
├── bench-models/              # Auto-fetched ONNX weights for bge-base/bge-large/all-MiniLM, used by the benchmark and by the demo app when `EDGE_MODEL` selects a non-bundled model (gitignored, SHA256-verified)
├── uploads/                   # Auto-fetched test PDF + user-uploaded PDFs (gitignored)
└── src/
    ├── main.ts                # Demo app entry — init Trovec, choose embedder, start server
    ├── benchmark.ts           # Benchmark entry — multi-model comparison
    ├── documents.ts           # Document registry — JSON-backed record of ingested PDFs
    ├── ingest.ts              # PDF parsing + paragraph chunking + embedding pipeline
    ├── search.ts              # Semantic search via Trovec queryByText
    ├── answer.ts              # LLM answer generation with anti-hallucination prompts
    ├── server.ts              # Express routes + static file serving
    ├── public/
    │   └── index.html         # Web UI (single file, inline CSS/JS)
    └── bench/
        ├── checksums.json     # Pinned SHA256s for reproducible benchmark fetches
        ├── models.ts          # Bench-only model registry
        ├── fetch-models.ts    # ONNX weight fetcher (idempotent, SHA256-verified)
        ├── fetch-corpus.ts    # PDF corpus fetcher (NIST SP 800-63B)
        ├── embedder.ts        # Composes Embedder for non-bundled models via low-level exports
        └── query-gen.ts       # gpt-5-nano paraphrased query generator (cached)
```
