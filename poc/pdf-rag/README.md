# PDF RAG POC

A proof-of-concept demonstrating [Trovec](https://www.npmjs.com/package/@trovec/core) for Retrieval-Augmented Generation (RAG) over PDF documents. Upload a PDF, ask natural language questions, and get cited answers grounded in the document content.

## How It Works

```
PDF Upload ──> LiteParse (extract text per page)
           ──> Paragraph-level chunking (100-500 chars)
           ──> Ollama embeddings (nomic-embed-text, 768d)
           ──> Trovec vector store (cosine similarity)

Question   ──> Trovec semantic search (top-K chunks)
           ──> OpenAI GPT-5.4-mini (synthesize answer with citations)
           ──> Cited answer + source references
```

### Key Components

| Component | Library | Purpose |
|-----------|---------|---------|
| Vector store | `@trovec/core` | Store and query document embeddings |
| Embeddings | `@trovec/embedder-ollama` | Generate 768-dim vectors via local Ollama |
| PDF parsing | `@llamaindex/liteparse` | Extract text with page-level structure |
| Answer generation | `openai` (Responses API) | Synthesize cited answers from retrieved chunks |
| Web server | `express` | API endpoints + static file serving |

### RAG Pipeline Details

**Ingestion:**
- LiteParse extracts text per page from the uploaded PDF
- Each page is split into paragraph-level chunks (100-500 chars) for more focused embeddings
- Chunks are prefixed with `search_document:` (required by nomic-embed-text) before embedding
- Each chunk stores metadata: page number, source file, full text, and a short preview

**Retrieval:**
- User questions are prefixed with `search_query:` before embedding
- Trovec performs brute-force cosine similarity search across all stored chunks
- Top-K most relevant chunks are returned with similarity scores

**Answer Generation:**
- Retrieved chunks (full text, not truncated) are sent to OpenAI as numbered sources
- Anti-hallucination prompt enforces: cite every claim, no outside knowledge, admit gaps
- Only citations actually referenced in the answer are returned to the UI
- LLM token usage (model, input/output tokens) is displayed for transparency

## Prerequisites

- **Node.js** >= 18
- **Ollama** running locally with `nomic-embed-text` model
- **OpenAI API key**

### Ollama Setup

```bash
# Install Ollama (https://ollama.com), then:
ollama pull nomic-embed-text
ollama serve
```

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

1. **Upload** a PDF using the upload area
2. **Ask** a natural language question (e.g., "What are the main security concerns?")
3. **Review** the synthesized answer with inline citation badges and expandable source references

## Configuration

Environment variables (can be set in `.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3737` | Server port |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `nomic-embed-text` | Ollama embedding model |
| `OPENAI_API_KEY` | *(required)* | OpenAI API key for answer generation |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/ingest` | Upload and ingest a PDF (multipart form, field: `pdf`) |
| `GET` | `/api/search?q=...&topK=5` | Raw semantic search (returns ranked chunks) |
| `POST` | `/api/ask` | Ask a question, get a cited answer (JSON body: `{ question, topK? }`) |
| `GET` | `/api/status` | Vector store stats (entry count, dimensions, metric) |

## Project Structure

```
poc/pdf-rag/
├── .env                 # Environment variables (not committed)
├── package.json
├── tsconfig.json
└── src/
    ├── main.ts          # Entry point — init Trovec, Ollama embedder, start server
    ├── ingest.ts        # PDF parsing + paragraph chunking + embedding pipeline
    ├── search.ts        # Semantic search via Trovec queryByText
    ├── answer.ts        # LLM answer generation with anti-hallucination prompts
    ├── server.ts        # Express routes + static file serving
    └── public/
        └── index.html   # Web UI (single file, inline CSS/JS)
```
