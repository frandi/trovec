# Embeddings

## What Are Embeddings?

**Embeddings** are numerical representations of data — typically text — in the form of vectors (arrays of numbers). An embedding model reads a piece of text and outputs a list of floating-point numbers that capture the **meaning** of that text in a way that computers can work with.

```
"The cat sat on the mat"  →  [0.021, -0.187, 0.452, 0.033, ..., -0.109]
                                         (1536 numbers)
```

The key insight is that **similar meanings produce similar vectors**. If two sentences talk about the same topic, their embedding vectors will be close to each other in vector space, even if they use completely different words.

```
"The cat sat on the mat"        →  [0.021, -0.187, 0.452, ...]
"A kitten was resting on a rug" →  [0.019, -0.191, 0.448, ...]   ← very close
"Stock prices rose sharply"     →  [0.871,  0.334, -0.052, ...]  ← very different
```

## What Is a Vector?

A **vector** is simply an array of numbers. In the context of embeddings, each number represents a learned feature of the input. You can think of a vector as coordinates in a high-dimensional space — just like a point on a 2D map has an (x, y) position, an embedding has a position in a space with hundreds or thousands of dimensions.

```
2D vector:     [x, y]              →  a point on a flat map
3D vector:     [x, y, z]           →  a point in physical space
1536D vector:  [v₁, v₂, ..., v₁₅₃₆]  →  a point in "meaning space"
```

We cannot visualize 1536 dimensions, but the math works the same way. Vectors that are close together represent similar meanings; vectors that are far apart represent different meanings.

## Why Do Embeddings Matter?

Embeddings unlock the ability to search by **meaning** rather than by exact keywords.

### Traditional keyword search

```
Query: "how to fix a flat tire"
Result: Only matches documents containing the exact words "fix", "flat", "tire"
Misses: "changing a punctured wheel" (same meaning, different words)
```

### Embedding-based semantic search

```
Query: "how to fix a flat tire"  →  embedding  →  [0.34, -0.12, ...]
                                                         ↓
                                         find closest vectors in the collection
                                                         ↓
Result: "changing a punctured wheel"  ← found because the meaning is similar
```

This is called **semantic search**, and it is the foundation of many modern AI applications: recommendation systems, retrieval-augmented generation (RAG), duplicate detection, clustering, and more.

## How Are Embeddings Generated?

Embedding models are neural networks trained on large amounts of text. They learn to map semantically similar inputs to nearby points in vector space. You do not need to understand how the model works internally — you just send text in and get numbers out.

### Using an embedding provider

Most embedding models are accessed through APIs:

```
Your text  →  [API call to OpenAI / Ollama / etc.]  →  embedding vector
```

Trovec supports several embedder integrations:

| Embedder | Model examples | Dimensions | Notes |
|---|---|---|---|
| OpenAI | `text-embedding-3-small` | 1536 | Cloud API, high quality |
| OpenAI | `text-embedding-3-large` | 3072 | Cloud API, highest quality |
| Ollama | `nomic-embed-text` | 768 | Local, no API key needed |
| Ollama | `all-minilm` | 384 | Local, lightweight |
| Local (hash) | — | 64 (default) | Deterministic, no semantic meaning. For testing only |

### The embedding model determines the vector

An important point: **you do not choose what the numbers mean**. The embedding model decides. Different models produce different vectors for the same text, and those vectors are not interchangeable. You must use the same model for both storing and querying.

## How Embeddings Work in Trovec

Trovec is a vector database. Its job is to **store** embedding vectors and **search** them efficiently. It can work with raw vectors directly, or with text through an embedder.

### Workflow 1: Text in, results out (with an embedder)

This is the most common workflow. You provide text and Trovec handles the embedding automatically.

```ts
import { create } from '@trovec/core';
import { createOpenAIEmbedder } from '@trovec/embedder-openai';

const db = await create({
  embedder: createOpenAIEmbedder({
    model: 'text-embedding-3-small',
    apiKey: process.env.OPENAI_API_KEY,
  }),
});

// Add documents — Trovec calls the embedder to convert text to vectors
await db.addWithText({
  id: 'doc-1',
  text: 'The cat sat on the mat',
  context: { category: 'animals' },
});

await db.addWithText({
  id: 'doc-2',
  text: 'Stock prices rose sharply today',
  context: { category: 'finance' },
});

// Search by meaning — Trovec embeds your query, then finds the closest vectors
const results = await db.queryByText({ text: 'kitten on a rug', topK: 5 });
// → doc-1 will rank highest (similar meaning to the query)
```

### Workflow 2: Raw vectors (without an embedder)

If you generate embeddings yourself (or get them from another source), you can work with raw number arrays:

```ts
const db = await create({ dimensions: 3 });

await db.add({
  id: 'vec-1',
  embedding: [0.1, 0.2, 0.3],
});

await db.add({
  id: 'vec-2',
  embedding: [0.9, 0.8, 0.7],
});

const results = await db.query([0.1, 0.2, 0.35], { topK: 5 });
// → vec-1 will rank highest (closest to the query vector)
```

### Batch operations

For efficiency, you can add multiple entries at once:

```ts
// With text
await db.addManyWithText([
  { id: 'doc-1', text: 'First document' },
  { id: 'doc-2', text: 'Second document' },
  { id: 'doc-3', text: 'Third document' },
]);

// With raw vectors
await db.addMany([
  { id: 'vec-1', embedding: [0.1, 0.2, 0.3] },
  { id: 'vec-2', embedding: [0.4, 0.5, 0.6] },
]);
```

Batch adds are **atomic** — if any entry fails validation, none of them are inserted.

### Filtering with context

Each entry can carry a `context` object with metadata. You can filter search results based on this metadata:

```ts
await db.addWithText({
  id: 'doc-1',
  text: 'The cat sat on the mat',
  context: { category: 'animals', year: 2024 },
});

// Only search within a specific category
const results = await db.queryByText({
  text: 'pets',
  topK: 5,
  filter: (ctx) => ctx?.category === 'animals',
});
```

## Real-World Example: PDF Search

A common use case is making PDF documents searchable by meaning. Here is a simplified flow based on Trovec's PDF RAG proof of concept:

**Ingestion (one-time):**

```
PDF → extract text → split into chunks → embed each chunk → store in Trovec
```

```ts
const chunks = extractChunksFromPDF('manual.pdf');

await db.addManyWithText(
  chunks.map((chunk, i) => ({
    id: `manual:p${chunk.page}:c${i}`,
    text: chunk.text,
    context: {
      page: chunk.page,
      source: 'manual.pdf',
      preview: chunk.text.slice(0, 200),
    },
  }))
);
```

**Search (at query time):**

```
User question → embed → find closest chunks → return relevant passages
```

```ts
const results = await db.queryByText({ text: 'how to reset the device', topK: 5 });

for (const r of results) {
  console.log(`Page ${r.context.page} (score: ${r.score})`);
  console.log(r.context.preview);
}
```

## Common Misconceptions

### "I can mix vectors from different models"

No. Each embedding model defines its own vector space. A vector from OpenAI's model and a vector from Ollama's model represent entirely different coordinate systems, even if they have the same number of dimensions. Always use the same model for storing and querying.

### "More dimensions = always better"

Not necessarily. Higher dimensions capture more nuance, but the quality depends on the model, not just the size. A well-trained 384-dimensional model can outperform a poorly trained 1536-dimensional one. Choose a model based on benchmarks and your use case, not just the dimension count.

### "I need to understand what each number means"

You don't. Embedding dimensions are learned features with no human-interpretable labels. You work with them as opaque arrays — the math (similarity metrics) handles the rest.

## How Embeddings Connect to Other Concepts

Embeddings are the foundation. The other concepts in this guide configure how Trovec handles them:

- **[Dimensions](./dimensions.md)** — The length of the embedding vector. Must match what the model produces.
- **[Quantization](./quantization.md)** — How the vector values are compressed for storage (F32, INT8, or BIT).
- **[Metric](./metric.md)** — How similarity between two vectors is calculated (cosine, euclidean, dot, or hamming).

## Key Takeaways

- Embeddings convert text into arrays of numbers that capture meaning.
- Similar meanings produce vectors that are close together in vector space.
- This enables **semantic search** — finding content by meaning, not keywords.
- Trovec stores these vectors and finds the most similar ones when you search.
- You can work with text (via an embedder) or raw vectors directly.
- Always use the same embedding model for storing and querying.
