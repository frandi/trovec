# Quantization

## What Is Quantization?

**Quantization** is the process of reducing the precision of the numbers in a vector to save memory and storage space. Instead of storing each value as a full-precision floating-point number, you can represent it using fewer bits — trading some accuracy for significant resource savings.

Think of it like image compression: a raw photo has perfect detail but takes lots of space, while a compressed JPEG looks nearly the same at a fraction of the size.

## Why Does Quantization Matter?

When working with vector embeddings at scale, storage and memory add up fast. Consider a collection of 1 million vectors with 1536 dimensions:

| Quantization | Bytes per value | Storage for 1M vectors | Relative size |
|---|---|---|---|
| F32 (32-bit float) | 8 bytes | ~11.5 GB | 100% |
| INT8 (8-bit integer) | 1 byte | ~1.4 GB | ~12.5% |
| BIT (1-bit binary) | 0.125 bytes | ~183 MB | ~1.6% |

Smaller storage also means faster search, because the CPU processes less data when comparing vectors.

## Quantization Types in Trovec

Trovec supports three quantization strategies via the `QuantizationType` setting: `'F32'`, `'INT8'`, and `'BIT'`.

### F32 — Full Precision (default)

Each dimension is stored as a 64-bit floating-point number, preserving the original values from the embedding model with no loss.

```
Original:  [0.5231, -0.1892, 0.7745]
Stored:    [0.5231, -0.1892, 0.7745]  (identical)
```

**When to use:** When accuracy is your top priority and storage is not a concern. This is the default and the safest choice.

### INT8 — 8-bit Integer Quantization

Each dimension is compressed into a single byte (-128 to 127) by mapping the vector's minimum and maximum values to the INT8 range. The min and max are stored alongside the data so the original values can be approximately reconstructed.

```
Original:  [0.5231, -0.1892, 0.7745]
Encoded:   [-128, 25, 127] (stored) + min=-0.1892, max=0.7745
Decoded:   [0.5184, -0.1892, 0.7745]  (close but not exact)
```

The encoding works by:
1. Finding the min and max of the vector
2. Scaling each value to the 0–255 range, then shifting by -128 to fit into a signed byte
3. Storing the min/max so the values can be approximately recovered

**When to use:** When you want a good balance between accuracy and storage. The precision loss is usually small enough that search quality is barely affected.

### BIT — Binary Quantization

Each dimension is reduced to a single bit: `1` if the value is >= 0, `0` if negative. Eight dimensions are packed into one byte.

```
Original:  [0.52, -0.19, 0.77, -0.41, 0.03, -0.88, 0.15, -0.62]
Encoded:   [1,     0,     1,    0,     1,    0,     1,    0   ] → 0xAA (1 byte)
Decoded:   [1.0,  -1.0,   1.0, -1.0,  1.0, -1.0,   1.0, -1.0]
```

This is the most aggressive compression. The exact magnitudes are lost entirely — only the sign of each dimension is preserved.

**When to use:** When you need maximum speed and minimal storage, and can tolerate lower precision. Best suited for large-scale approximate search or first-pass filtering before a more precise re-ranking step.

## Quantization and Metrics

The choice of quantization constrains which distance metric you can use:

| Quantization | Compatible metrics |
|---|---|
| F32 | `cosine`, `euclidean`, `hamming` |
| INT8 | `cosine`, `euclidean` |
| BIT | `hamming` (required) |

BIT quantization **requires** the `hamming` metric because the data is binary. Hamming distance counts the number of bits that differ between two vectors, which is the natural way to compare binary vectors.

## Using Quantization in Trovec

### Setting the quantization type

```ts
// Full precision (default — same as omitting the option)
const db = await create({ dimensions: 1536, quantization: 'F32' });

// 8-bit integer quantization
const db = await create({ dimensions: 1536, quantization: 'INT8' });

// Binary quantization (must use hamming metric)
const db = await create({ dimensions: 128, quantization: 'BIT', metric: 'hamming' });
```

### Quantization is transparent

You always provide and receive normal floating-point vectors. Trovec handles encoding and decoding internally:

```ts
const db = await create({ dimensions: 3, quantization: 'INT8' });

// You add normal float vectors — Trovec encodes them as INT8 internally
await db.add({
  id: 'doc-1',
  embedding: [0.5231, -0.1892, 0.7745],
});

// Query results return decoded floats (approximately equal to the originals)
const results = await db.query([0.5, -0.2, 0.8], { topK: 5 });
```

### CLI usage

```bash
trovec init --dimensions 128 --quantization INT8 --metric euclidean
```

## How to Choose

| Scenario | Recommended |
|---|---|
| Prototyping or small datasets | `F32` — no precision loss, simplest to reason about |
| Production with moderate scale | `INT8` — significant storage savings with minimal quality loss |
| Very large scale or first-pass retrieval | `BIT` — maximum compression, use with a re-ranking step |
| Need exact similarity scores | `F32` — the only option with zero information loss |

## Key Takeaways

- Quantization reduces the precision of vector values to save storage and speed up search.
- Trovec supports three levels: `F32` (full precision), `INT8` (8x smaller), and `BIT` (64x smaller).
- Lower precision means some information loss, but search quality often remains acceptable.
- BIT quantization requires the `hamming` metric; F32 and INT8 work with `cosine` and `euclidean`.
- Quantization is handled internally — you always work with normal float arrays.
