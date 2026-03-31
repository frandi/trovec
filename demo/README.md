# Trovec Demo

Interactive CLI demo that showcases Trovec's core capabilities: embedding, storage, persistence, similarity search, and metadata filtering.

## Prerequisites

- Node.js >= 18.0.0
- Dependencies installed from the monorepo root (`npm install`)

## Quick Start

```bash
npm start
```

The demo will guide you through interactive prompts to configure storage and embedder options.

## How It Works

On start, the demo asks you to choose:

1. **Storage** — In-memory (default) or Persisted (file)
2. **Existing data** — If persisted data is found, continue with it or start fresh
3. **Embedder** — Local (default), OpenAI, or Ollama (skipped when reusing persisted data)

Based on your selections, the demo runs through the relevant steps:

| Step | Description | When |
|------|-------------|------|
| **Initialize** | Creates a Trovec instance with selected embedder, storage, and config | Always |
| **Restore from File** | Deserializes previously persisted data | Reusing persisted data |
| **Embed & Store** | Embeds 64 sample documents and stores them with metadata | Fresh start |
| **Persist to File** | Flushes to disk with Brotli compression, shows compression ratio | Persisted + fresh |
| **Serialize to Memory** | Flushes to in-memory buffer, shows buffer size | In-memory + fresh |
| **Similarity Search** | Runs 3 semantic queries and ranks results by cosine similarity | Always |
| **Filtered Query** | Searches with a metadata filter (category = animals) | Always |
| **Final Stats** | Prints database statistics | Always |

Persisted data is kept between runs in `.trovec/` so you can reuse it on the next start.

## Embedders

| Mode | Dimensions | Notes |
|------|------------|-------|
| Local | 64 | Trigram hash-based, zero dependencies, fully offline |
| OpenAI | 1536 | Uses `text-embedding-3-small`, requires API key |
| Ollama | 768 | Uses `nomic-embed-text`, requires a running [Ollama](https://ollama.com/) server (see [setup guide](../docs/ollama.md)) |

When selecting OpenAI, the demo looks for `OPENAI_API_KEY` in `.trovec/.env`, then in your environment. If not found, it will prompt you to enter the key (masked), and save it to `.trovec/.env` for future runs.

### What to Expect from Each Mode

The **local embedder** is a lightweight trigram hash — great for quick testing and offline development, but it produces lower-quality embeddings. You'll notice some odd results in similarity search (e.g. "espresso" matching "pets and animals", or "cats" matching "similarity search") because the 64-dimension hash space can't capture deep semantic meaning.

The **OpenAI embedder** produces significantly better results:

- **More relevant rankings** — no nonsensical matches; related documents consistently rank higher
- **Better score separation** — clear gap between relevant and irrelevant results, making top-K cutoffs more meaningful
- **No negative scores** — local can produce negative cosine scores (essentially noise), while OpenAI scores are positive and well-distributed

The **Ollama embedder** performs well and runs entirely locally:

- **High similarity scores** — produces the highest absolute scores of all three modes (e.g. 0.72 vs 0.47 for "pets and animals")
- **Good semantic ranking** — correctly groups related documents together, comparable to OpenAI
- **Fast after warm-up** — first embed takes ~1-2s (model loading), subsequent embeds take ~20-35ms
- **No API key needed** — fully private, no data leaves your machine

### Speed vs Quality Summary

| Mode | Embed Speed | Search Quality | Setup |
|------|------------|----------------|-------|
| Local | <1ms | Basic (trigram hash, some odd matches) | None |
| Ollama | 20-35ms (after warm-up) | Good (semantic, strong score separation) | Ollama server |
| OpenAI | 200-700ms | Best (semantic, cleanest separation) | API key |

For development and CI, local is fine. For evaluating real search quality locally, use Ollama. For production-grade quality, use OpenAI.

## Sample Output

```
  ╔══════════════════════════════════════════════════════════════╗
  ║                  Trovec CLI Demo                              ║
  ║          Vector Database Library for Node.js                 ║
  ╚══════════════════════════════════════════════════════════════╝

  This demo walks through Trovec's core features: embedding documents,
  persisting data, and running similarity searches. Choose your options below.

  Storage:
    [1] In-memory (default)
    [2] Persisted (file)
  > 1

  Embedder:
    [1] Local (no setup needed) (default)
    [2] OpenAI (requires API key)
    [3] Ollama (requires running server)
  > 1

   STEP 1  Initialize Trovec Instance
  ────────────────────────────────────────────────────────────────
    Embedder: Local (trigram hash)
    Dimensions: 64
    Quantization: F32
    Metric: cosine
    Storage: MemoryDriver
    ✓ Instance created

   STEP 2  Embed & Store Documents
  ────────────────────────────────────────────────────────────────
    Documents: 64 entries to embed and store

    › doc-01 (0.4ms)
       "Cats are independent and curious animals that have been domesticated for thousands of years"
       → [0.0000, 0.0000, -0.1033, -0.0516, -0.0516, ... ] (64 dims)
    ...
    ✓ Stored 64 entries

   STEP 4  Similarity Search
  ────────────────────────────────────────────────────────────────

    Query: "pets and animals" (Broad animal query)
    Results (top 3):
    #1  doc-01  score=0.4698 {"category":"animals","source":"encyclopedia"}
    #2  doc-02  score=0.3325 {"category":"animals","source":"encyclopedia"}
    #3  doc-08  score=0.2362 {"category":"food","source":"wiki"}

   DONE  Demo completed successfully.
```
