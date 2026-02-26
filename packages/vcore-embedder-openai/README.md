# vcore-embedder-openai

OpenAI embeddings adapter for [VCore](../vcore/README.md). Converts text to vector embeddings using the OpenAI Embeddings API.

Zero runtime dependencies — uses Node.js 18+ built-in `fetch`.

## Installation

```bash
npm install vcore vcore-embedder-openai
```

## Usage

```typescript
import { create, addWithText, queryByText } from 'vcore';
import { createOpenAIEmbedder } from 'vcore-embedder-openai';

const db = create({
  dimensions: 1536,
  embedder: createOpenAIEmbedder({
    apiKey: process.env.OPENAI_API_KEY!,
  }),
});

await addWithText(db, { id: 'doc1', text: 'The cat sat on the mat' });
await addWithText(db, { id: 'doc2', text: 'Dogs love to play fetch' });

const results = await queryByText(db, { text: 'animals sitting', topK: 5 });
```

## Options

```typescript
createOpenAIEmbedder({
  apiKey: string;           // required: your OpenAI API key
  model?: string;           // default: 'text-embedding-3-small'
  baseUrl?: string;         // default: 'https://api.openai.com/v1'
})
```

### Models

| Model | Dimensions | Notes |
|-------|-----------|-------|
| `text-embedding-3-small` | 1536 | Default, good balance of quality and cost |
| `text-embedding-3-large` | 3072 | Higher quality, higher cost |
| `text-embedding-ada-002` | 1536 | Legacy model |

### Custom Endpoint

Use `baseUrl` for proxies or OpenAI-compatible APIs (Azure, local LLM servers):

```typescript
createOpenAIEmbedder({
  apiKey: 'your-key',
  baseUrl: 'https://your-proxy.com/v1',
})
```

## License

MIT
