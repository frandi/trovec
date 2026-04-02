# @trovec/embedder-openai

OpenAI embeddings adapter for [Trovec](../core/README.md). Converts text to vector embeddings using the OpenAI Embeddings API.

Zero runtime dependencies — uses Node.js 18+ built-in `fetch`.

## Installation

```bash
npm install @trovec/core @trovec/embedder-openai
```

## Usage

```typescript
import { create, addWithText, queryByText } from '@trovec/core';
import { createOpenAIEmbedder } from '@trovec/embedder-openai';

const db = await create({
  embedder: createOpenAIEmbedder({
    apiKey: process.env.OPENAI_API_KEY!,
  }),
});
// dimensions are automatically resolved from the embedder (1536 for the default model)

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
  dimensions?: number;      // auto-resolved for known models; required for custom models
})
```

The returned embedder exposes read-only `dimensions` and `model` properties. Trovec uses `dimensions` to auto-configure itself; `model` is available for logging and diagnostics.

### Models

| Model | Dimensions | Notes |
|-------|-----------|-------|
| `text-embedding-3-small` | 1536 | Default, good balance of quality and cost |
| `text-embedding-3-large` | 3072 | Higher quality, higher cost |
| `text-embedding-ada-002` | 1536 | Legacy model |

For models not in the list above (custom or OpenAI-compatible endpoints), pass `dimensions` explicitly:

```typescript
createOpenAIEmbedder({
  apiKey: 'your-key',
  model: 'custom-model',
  dimensions: 2048,
})
```

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
