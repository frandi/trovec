# PDF RAG POC

A proof-of-concept demonstrating [Trovec](https://www.npmjs.com/package/@trovec/core) for Retrieval-Augmented Generation (RAG) over PDF documents. Upload a PDF, ask natural language questions, and get cited answers grounded in the document content.

This directory now hosts two related things:

1. **The demo app** — an Express server with a single-page UI. Defaults to running with `@trovec/embedder-edge` so it works offline without API keys for ingest and search; OpenAI is needed only for LLM-generated answers.
2. **The embedder benchmark** — a head-to-head comparison of `embedder-edge` (multiple ONNX models) against `embedder-openai` on a fixed English corpus. See [`BENCHMARK.md`](./BENCHMARK.md) for results, methodology, and scenario-based recommendations.

## How It Works

```
PDF Upload ──> LiteParse (extract text per page)
           ──> Paragraph-level chunking (100-500 chars)
           ──> Embeddings (default: bundled bge-small-en-v1.5 via @trovec/embedder-edge)
           ──> Trovec vector store (cosine similarity, file-backed)

Question   ──> Trovec semantic search (top-K chunks)
           ──> OpenAI chat completion (synthesize answer with citations)
           ──> Cited answer + source references
```

### Key Components

| Component | Library | Purpose |
|-----------|---------|---------|
| Vector store | `@trovec/core` | Store and query document embeddings (concurrent-safe file storage with optional AES-256-GCM encryption at rest) |
| Embeddings | `@trovec/embedder-edge` (default) or `@trovec/embedder-openai` | Generate vectors locally (offline, ~12 ms p50) or via cloud API |
| PDF parsing | `@llamaindex/liteparse` | Extract text with page-level structure |
| Answer generation | `openai` chat completions | Synthesize cited answers from retrieved chunks |
| Web server | `express` | API endpoints + static file serving |

### RAG Pipeline Details

**Ingestion:**
- LiteParse extracts text per page from the uploaded PDF
- Each page is split into paragraph-level chunks (100-500 chars) for more focused embeddings
- Each chunk stores metadata: page number, source file, full text, and a short preview
- Data is persisted via Trovec's **concurrent file storage driver** (`createConcurrentFileDriver`), which uses a write-ahead log and OS-level file locking so multiple ingest requests can write safely in parallel
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
npm start
```

Open http://localhost:3737. Upload a PDF, then either:

- Use the search panel directly — works without an API key.
- For cited LLM answers, drop an `OPENAI_API_KEY=sk-...` into a `.env` file and restart.

The first request triggers a one-time ONNX session load for the bundled bge-small-en-v1.5 model (~100–500 ms). Subsequent requests are steady-state (~12 ms median per query on a typical laptop).

## Embedder choice

The default is `@trovec/embedder-edge` (offline, in-process, ~32 MB ONNX model bundled with the package). Switch to OpenAI embeddings via env var:

```bash
EMBEDDER=openai npm start
```

Trade-offs (numbers from [`BENCHMARK.md`](./BENCHMARK.md)):

| | `EMBEDDER=edge` (default) | `EMBEDDER=openai` |
|---|---|---|
| Setup | None — model bundled with `@trovec/embedder-edge` | Requires `OPENAI_API_KEY` for embeddings *and* answer generation |
| Network | None for embedding (only for `/api/ask`) | Required for both embedding and `/api/ask` |
| Quality (recall@1, NIST corpus) | 53.3% (bge-small INT8) | 56.7% (text-embedding-3-small) |
| Query latency (p50) | ~12 ms | ~400 ms |
| Bulk-ingest throughput | ~3–8 chunks/sec (CPU inference) | ~37 chunks/sec (API batching) |
| Per-call cost | $0 | per-token billing |

For higher local quality, plug in `bge-base-en-v1.5` or `bge-large-en-v1.5` weights via the `modelPath` option (see [`@trovec/embedder-edge`](../../packages/embedder-edge/) README). Both *beat* `text-embedding-3-small` on retrieval quality on this benchmark.

> **Heads up: switching embedders mid-collection produces silent errors.** Different embedders produce vectors in different spaces. Trovec records the embedder identity at ingest time and emits a `console.warn` on mismatch (introduced in `@trovec/core@2.3.0`). If you switch, delete the `.trovec/` directory and re-ingest.

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
| `EMBEDDER` | `edge` | Embedder backend: `edge` (bundled ONNX, offline) or `openai` (cloud API) |
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

## Project Structure

```
poc/pdf-rag/
├── .env                       # Environment variables (not committed)
├── .trovec/                   # Persisted vector store data + document registry (auto-created)
├── package.json
├── tsconfig.json
├── BENCHMARK.md               # Embedder comparison report (committed)
├── BENCHMARK_RESULTS.json     # Latest raw benchmark output (gitignored)
├── bench-queries.json         # LLM-paraphrased query cache (gitignored)
├── bench-models/              # Auto-fetched bench-only ONNX weights (gitignored)
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
