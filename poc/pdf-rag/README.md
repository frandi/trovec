# PDF RAG POC

A proof-of-concept demonstrating [Trovec](https://www.npmjs.com/package/@trovec/core) for Retrieval-Augmented Generation (RAG) over PDF documents. Upload a PDF, ask natural language questions, and get cited answers grounded in the document content.

## How It Works

```
PDF Upload ──> LiteParse (extract text per page)
           ──> Paragraph-level chunking (100-500 chars)
           ──> OpenAI embeddings (text-embedding-3-small, 1536d)
           ──> Trovec vector store (cosine similarity, file-backed)

Question   ──> Trovec semantic search (top-K chunks)
           ──> OpenAI GPT-5.4-mini (synthesize answer with citations)
           ──> Cited answer + source references
```

### Key Components

| Component | Library | Purpose |
|-----------|---------|---------|
| Vector store | `@trovec/core` | Store and query document embeddings (concurrent-safe file storage with optional AES-256-GCM encryption at rest) |
| Embeddings | `@trovec/embedder-openai` | Generate 1536-dim vectors via OpenAI API |
| PDF parsing | `@llamaindex/liteparse` | Extract text with page-level structure |
| Answer generation | `openai` (Responses API) | Synthesize cited answers from retrieved chunks |
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

- **Node.js** >= 18
- **OpenAI API key**

## Getting Started

```bash
cd poc/pdf-rag
npm install
```

Create a `.env` file:

```
OPENAI_API_KEY=sk-...
```

Start the server:

```bash
npm start
```

Open http://localhost:3737 in your browser.

## Usage

The UI is split into two panels:

- **Left panel** — Upload PDFs and browse the document list. Each document can be deleted, which removes its vectors, metadata record, and uploaded file.
- **Right panel** — Ask natural language questions and review cited answers with expandable source references.

Ingested data is persisted in the `.trovec` directory, so previously uploaded documents are available across restarts.

## Configuration

Environment variables (can be set in `.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3737` | Server port |
| `OPENAI_API_KEY` | *(required)* | OpenAI API key for embeddings and answer generation |
| `TROVEC_ENCRYPTION_KEY` | *(optional)* | 64-char hex string (32 raw bytes) — enables AES-256-GCM encryption at rest using a raw key |
| `TROVEC_ENCRYPTION_PASSWORD` | *(optional)* | Passphrase — enables AES-256-GCM encryption at rest using a PBKDF2-derived key. Ignored if `TROVEC_ENCRYPTION_KEY` is set |

### Generating an encryption key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Save the output as `TROVEC_ENCRYPTION_KEY` in your `.env`. **Losing the key means losing the data** — there is no recovery path.

> **Already have a plaintext `.trovec/` directory from a previous run?** You can't just set `TROVEC_ENCRYPTION_KEY` — the server will fail to start with an `EncryptionError`. Instead, follow the [encryption-at-rest migration guide](../../docs/migration/encryption-at-rest.md), which uses this POC as the worked example.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/ingest` | Upload and ingest a PDF (multipart form, field: `pdf`) |
| `GET` | `/api/documents` | List all ingested documents |
| `DELETE` | `/api/documents/:fileName` | Delete a document (vectors, record, and uploaded file) |
| `GET` | `/api/search?q=...&topK=5` | Raw semantic search (returns ranked chunks) |
| `POST` | `/api/ask` | Ask a question, get a cited answer (JSON body: `{ question, topK? }`) |
| `GET` | `/api/status` | Vector store stats (entry count, dimensions, metric) |

## Project Structure

```
poc/pdf-rag/
├── .env                 # Environment variables (not committed)
├── .trovec/             # Persisted vector store data + document registry (auto-created)
├── package.json
├── tsconfig.json
└── src/
    ├── main.ts          # Entry point — init Trovec, OpenAI embedder, start server
    ├── documents.ts     # Document registry — JSON-backed record of ingested PDFs
    ├── ingest.ts        # PDF parsing + paragraph chunking + embedding pipeline
    ├── search.ts        # Semantic search via Trovec queryByText
    ├── answer.ts        # LLM answer generation with anti-hallucination prompts
    ├── server.ts        # Express routes + static file serving
    └── public/
        └── index.html   # Web UI (single file, inline CSS/JS)
```
