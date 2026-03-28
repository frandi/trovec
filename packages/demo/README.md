# VCore Demo

Interactive CLI demo that showcases VCore's core capabilities: embedding, storage, persistence, similarity search, and metadata filtering.

## Prerequisites

- Node.js >= 18.0.0
- Dependencies installed from the monorepo root (`npm install`)

## Quick Start

```bash
# Default — uses local embedder, no API key needed
npm start

# With OpenAI embeddings (requires OPENAI_API_KEY)
OPENAI_API_KEY=sk-... npm run start:openai
```

## What the Demo Does

The demo walks through 7 steps in sequence:

| Step | Name | Description |
|------|------|-------------|
| 1 | **Initialize VCore Instance** | Creates a vector database configured with an embedder, quantization, metric, and storage driver |
| 2 | **Embed & Store Documents** | Embeds 8 sample documents (animals, programming, databases, food) and stores them with metadata |
| 3 | **Persist to Storage** | Serializes the database to a `MemoryDriver` buffer |
| 4 | **Restore from Storage** | Creates a fresh instance and deserializes the buffer back into it |
| 5 | **Similarity Search** | Runs 3 semantic queries ("pets and animals", "JavaScript programming", "similarity search") and ranks results by cosine similarity |
| 6 | **Filtered Query** | Searches "curious creatures" with a metadata filter that limits results to the "animals" category |
| 7 | **Final Stats** | Prints database statistics (entry count, dimensions, quantization, metric, index type) |

## Embedder Modes

| Mode | Flag | Dimensions | Notes |
|------|------|------------|-------|
| Local | *(default)* | 64 | Trigram hash-based, zero dependencies, fully offline |
| OpenAI | `--openai` | 1536 | Uses `text-embedding-3-small`, falls back to local if `OPENAI_API_KEY` is not set |

### What to Expect from Each Mode

The **local embedder** is a lightweight trigram hash — great for quick testing and offline development, but it produces lower-quality embeddings. You'll notice some odd results in similarity search (e.g. "espresso" matching "pets and animals", or "cats" matching "similarity search") because the 64-dimension hash space can't capture deep semantic meaning.

The **OpenAI embedder** produces significantly better results:

- **More relevant rankings** — no nonsensical matches; related documents consistently rank higher
- **Better score separation** — clear gap between relevant and irrelevant results, making top-K cutoffs more meaningful
- **No negative scores** — local can produce negative cosine scores (essentially noise), while OpenAI scores are positive and well-distributed

The trade-off is **speed**: local embeds in <1ms per document, while OpenAI takes 200-700ms due to API round-trips. For development and CI, local is fine. For evaluating real search quality, use OpenAI.

## Sample Output

```
  ╔══════════════════════════════════════════════════════════════╗
  ║                  VCore CLI Demo                              ║
  ║          Vector Database Library for Node.js                 ║
  ╚══════════════════════════════════════════════════════════════╝

   STEP 1  Initialize VCore Instance
  ────────────────────────────────────────────────────────────────
    Embedder: Local (trigram hash)
    Dimensions: 64
    Quantization: F32
    Metric: cosine
    Storage: MemoryDriver
    ✓ Instance created

   STEP 2  Embed & Store Documents
  ────────────────────────────────────────────────────────────────
    Documents: 8 entries to embed and store

    › doc-1 (0.4ms)
       "Cats are independent and curious animals"
       → [0.0000, 0.0000, -0.1033, -0.0516, -0.0516, ... ] (64 dims)
    ...
    ✓ Stored 8 entries

   STEP 5  Similarity Search
  ────────────────────────────────────────────────────────────────

    Query: "pets and animals" (Broad animal query)
    Results (top 3):
    #1  doc-1  score=0.4698 {"category":"animals","source":"encyclopedia"}
    #2  doc-2  score=0.3325 {"category":"animals","source":"encyclopedia"}
    #3  doc-8  score=0.2362 {"category":"food","source":"wiki"}

   DONE  Demo completed successfully.
```
