# vcore-embedder-local

A zero-dependency local text embedder for [VCore](../vcore/README.md). Converts text to vector embeddings using character n-gram hashing — no API keys, no model files, no setup required.

> **Warning:** This embedder uses simple text hashing, not a real ML model. It does not capture true semantic meaning. **Use it for prototyping, testing, CI, and demos only.** For production, use a proper embedding model like [`vcore-embedder-openai`](../vcore-embedder-openai/).

## Installation

```bash
npm install vcore vcore-embedder-local
```

## Usage

```typescript
import { create, addWithText, queryByText } from 'vcore';
import { createLocalEmbedder } from 'vcore-embedder-local';

const db = create({
  dimensions: 64,
  embedder: createLocalEmbedder(),
});

await addWithText(db, { id: 'doc1', text: 'Cats are curious animals' });
await addWithText(db, { id: 'doc2', text: 'Dogs love to play fetch' });
await addWithText(db, { id: 'doc3', text: 'TypeScript adds static typing' });

const results = await queryByText(db, { text: 'pets and animals', topK: 2 });
// Returns doc1 and doc2 (animal-related documents rank higher)
```

## Options

```typescript
createLocalEmbedder({
  dimensions?: number;  // default: 64
  warn?: boolean;       // default: true — prints a one-time warning to stderr
})
```

### Suppressing the Warning

The embedder prints a one-time warning on first use to remind you it's not for production. To suppress it:

```typescript
createLocalEmbedder({ warn: false })
```

## How It Works

1. Tokenizes input text by whitespace
2. Extracts character bigrams and trigrams from each token
3. Hashes each n-gram to a dimension index using a multiply-and-xor hash
4. Accumulates weighted values into a fixed-size vector
5. L2-normalizes the result to unit length

This produces deterministic, reproducible embeddings that capture surface-level text similarity (shared character sequences) rather than deep semantic meaning.

## When to Use This vs a Real Embedder

| Use case | Recommended embedder |
|----------|---------------------|
| Learning the VCore API | `vcore-embedder-local` |
| Unit tests / CI | `vcore-embedder-local` |
| Demos and prototypes | `vcore-embedder-local` |
| Production search | `vcore-embedder-openai` or similar |
| Semantic similarity | `vcore-embedder-openai` or similar |

## License

MIT
