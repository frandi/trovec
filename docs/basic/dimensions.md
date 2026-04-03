# Dimensions

## What Are Dimensions?

In the context of vector embeddings, **dimensions** refer to the number of numerical values that make up a single vector. When text (or other data) is converted into a vector by an embedding model, the result is an array of floating-point numbers. The length of that array is the vector's dimensionality.

For example, a 3-dimensional vector might look like this:

```
[0.12, -0.45, 0.78]
```

A 1536-dimensional vector (common in real-world models) would contain 1536 such numbers. Each number captures some learned aspect of the input's meaning.

## Why Do Dimensions Matter?

### Representational capacity

More dimensions give the model more room to encode nuances of meaning. A 3072-dimensional vector can distinguish between concepts that a 256-dimensional vector might blur together.

### Performance trade-offs

Higher dimensions come at a cost:

| Factor | Lower dimensions | Higher dimensions |
|---|---|---|
| Storage size | Smaller | Larger |
| Search speed | Faster | Slower |
| Memory usage | Lower | Higher |
| Semantic detail | Less precise | More precise |

Choosing dimensions is a balance between accuracy and resource usage.

### Consistency requirement

All vectors in a collection **must** have the same number of dimensions. You cannot mix a 384-dimensional vector with a 1536-dimensional vector in the same collection, because distance calculations require vectors of equal length.

## Common Dimension Sizes

Different embedding models produce vectors of different sizes:

| Model | Dimensions |
|---|---|
| OpenAI `text-embedding-3-small` | 1536 |
| OpenAI `text-embedding-3-large` | 3072 |
| OpenAI `text-embedding-ada-002` | 1536 |
| Ollama `nomic-embed-text` | 768 |
| Sentence Transformers `all-MiniLM-L6-v2` | 384 |

## Using Dimensions in Trovec

In `TrovecConfig`, you can specify dimensions explicitly or let the embedder define them.

### Option 1: Explicit dimensions (when adding raw vectors)

If you are adding pre-computed vectors without an embedder, you must specify the dimensions:

```ts
const trovec = new Trovec({ dimensions: 384 });

// Every vector you add must have exactly 384 numbers
await trovec.add({
  id: 'doc-1',
  embedding: [0.12, -0.45, 0.78, /* ... 381 more values */],
  metadata: { title: 'My document' },
});
```

### Option 2: Embedder-provided dimensions

When you provide an embedder, Trovec reads the dimensions from the embedder automatically:

```ts
const embedder = new OpenAIEmbedder({ model: 'text-embedding-3-small' });
// No need to specify dimensions - the embedder reports 1536
const trovec = new Trovec({ embedder });
```

### What if both are specified?

If you provide both `dimensions` and an `embedder`, they must match. Trovec throws an `InvalidConfigError` if they disagree:

```ts
// This will throw an error because the model produces 1536-dimensional vectors
const trovec = new Trovec({
  dimensions: 512,
  embedder: new OpenAIEmbedder({ model: 'text-embedding-3-small' }),
});
```

### Validation at runtime

Trovec validates every vector against the configured dimensions. If you try to add a vector with a different length, a `DimensionMismatchError` is thrown:

```ts
const trovec = new Trovec({ dimensions: 3 });

// This will throw because the vector has 4 elements, not 3
await trovec.add({
  id: 'doc-1',
  embedding: [0.1, 0.2, 0.3, 0.4],
});
```

## How to Choose the Right Dimensions

1. **Using an embedder?** Let the model decide. Each model is trained for a specific dimensionality, and using a different size will degrade quality.
2. **Building a prototype?** Start with a smaller model (384 or 768 dimensions) for faster iteration.
3. **Need high accuracy?** Use a larger model (1536 or 3072 dimensions) and benchmark against your specific data.
4. **Constrained on resources?** Lower dimensions reduce storage and speed up search, which matters at scale.

## Key Takeaways

- Dimensions = the length of a vector (how many numbers it contains).
- All vectors in a collection must share the same dimensions.
- Higher dimensions capture more meaning but use more resources.
- In Trovec, dimensions can come from the config, the embedder, or both (as long as they match).
