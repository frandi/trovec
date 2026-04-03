# Metric

## What Is a Metric?

A **metric** (also called a distance metric or similarity metric) is the mathematical function used to measure how similar or different two vectors are. When you search for the nearest neighbors to a query vector, the metric determines how "closeness" is calculated.

Different metrics capture different notions of similarity. Choosing the right one depends on what your vectors represent and how they were produced.

## Why Does the Metric Matter?

Two vectors can appear "close" or "far apart" depending on which metric you use. For example, two vectors that point in the same direction but have very different lengths would score highly with cosine similarity (same direction) but poorly with euclidean distance (far apart in space).

Using the wrong metric can cause your search results to be less relevant — even if your embeddings are excellent.

## Metrics in Trovec

Trovec supports four metrics via the `MetricType` setting: `'cosine'`, `'euclidean'`, `'dot'`, and `'hamming'`.

All metrics in Trovec return a **similarity score** — a higher value means the vectors are more similar.

---

### Cosine (default)

Cosine similarity measures the **angle** between two vectors, ignoring their magnitude. It answers the question: "Are these vectors pointing in the same direction?"

**Score range:** -1 to 1
- `1` = identical direction
- `0` = perpendicular (unrelated)
- `-1` = opposite direction

**Formula:**

```
cosine(A, B) = (A · B) / (‖A‖ × ‖B‖)
```

**Visual intuition:**

```
        B
       ↗
      /  θ = small angle → high similarity
     /
    --------→ A
```

**Example:**

```
A = [1, 0]      B = [1, 0]       → cosine = 1.0   (identical)
A = [1, 0]      B = [0, 1]       → cosine = 0.0   (unrelated)
A = [1, 0]      B = [-1, 0]      → cosine = -1.0  (opposite)
A = [1, 0]      B = [100, 0]     → cosine = 1.0   (same direction, magnitude ignored)
```

**When to use:** This is the most common metric for text embeddings. Most embedding models (OpenAI, Sentence Transformers, etc.) are trained to produce vectors where cosine similarity reflects semantic similarity. **When in doubt, use cosine.**

---

### Euclidean

Euclidean similarity measures the **straight-line distance** between two points in space, then converts it to a similarity score. It considers both direction and magnitude.

**Score range:** 0 to 1
- `1` = identical vectors (distance = 0)
- Approaches `0` as vectors get farther apart

**Formula:**

```
euclidean_similarity(A, B) = 1 / (1 + √(Σ(Aᵢ - Bᵢ)²))
```

The raw Euclidean distance is converted to a similarity by `1 / (1 + distance)`, so that higher values still mean "more similar."

**Visual intuition:**

```
    B •

          d = large distance → low similarity

                   • A
```

**Example:**

```
A = [1, 0]      B = [1, 0]       → similarity = 1.0    (identical)
A = [1, 0]      B = [2, 0]       → similarity = 0.5    (distance = 1)
A = [1, 0]      B = [4, 0]       → similarity = 0.25   (distance = 3)
A = [1, 0]      B = [100, 0]     → similarity ≈ 0.01   (very far)
```

**When to use:** When the magnitude of your vectors is meaningful. For instance, if longer vectors represent "stronger" signals and you want to account for that, euclidean captures differences that cosine would ignore.

---

### Dot Product

The dot product measures a combination of **direction and magnitude**. It rewards vectors that point in the same direction **and** have large magnitudes.

**Score range:** unbounded (can be any number, positive or negative)
- Large positive = similar direction and large magnitudes
- `0` = perpendicular or zero-length
- Large negative = opposite direction

**Formula:**

```
dot(A, B) = Σ(Aᵢ × Bᵢ)
```

**Example:**

```
A = [1, 0]      B = [1, 0]       → dot = 1
A = [3, 0]      B = [3, 0]       → dot = 9     (magnitude matters)
A = [1, 0]      B = [0, 1]       → dot = 0     (perpendicular)
A = [1, 0]      B = [-1, 0]      → dot = -1    (opposite)
```

**When to use:** When your vectors are already normalized (unit length), dot product is equivalent to cosine similarity but slightly faster (no need to compute norms). Some models produce normalized vectors by design, making dot product a good choice.

---

### Hamming

Hamming similarity measures the **proportion of matching bits** between two binary vectors. It is designed for use with `BIT` quantization.

**Score range:** 0 to 1
- `1` = all bits match (identical)
- `0` = no bits match

**Formula:**

```
hamming(A, B) = matching_bits / total_bits
```

**Example:**

```
A = [1, 0, 1, 1, 0, 0, 1, 0]
B = [1, 0, 1, 0, 0, 0, 1, 1]
                 ↑           ↑   ← 2 bits differ out of 8
→ similarity = 6/8 = 0.75
```

**When to use:** Only with `BIT` quantization. Hamming is extremely fast because comparing bits is a cheap CPU operation (XOR + popcount). Ideal for large-scale approximate search where speed matters more than precision.

## Metric and Quantization Compatibility

Not all metric/quantization combinations are valid:

| Metric | F32 | INT8 | BIT |
|---|---|---|---|
| `cosine` | Yes | Yes | No |
| `euclidean` | Yes | Yes | No |
| `dot` | Yes | Yes | No |
| `hamming` | No | No | **Required** |

Trovec validates this at configuration time and throws an `InvalidConfigError` if the combination is invalid.

## Using Metrics in Trovec

### Setting the metric

```ts
// Cosine similarity (default — same as omitting the option)
const db = await create({ dimensions: 1536, metric: 'cosine' });

// Euclidean similarity
const db = await create({ dimensions: 1536, metric: 'euclidean' });

// Dot product
const db = await create({ dimensions: 1536, metric: 'dot' });

// Hamming (requires BIT quantization)
const db = await create({ dimensions: 128, metric: 'hamming', quantization: 'BIT' });
```

### The metric affects query results

The same data can produce different rankings depending on the metric:

```ts
// Suppose we have these vectors stored:
// "cat"  → [0.9, 0.1]
// "dog"  → [0.8, 0.3]
// "car"  → [5.0, 0.5]

// Cosine: "car" and "cat" might score similarly (both point roughly in the x-direction)
// Euclidean: "car" is far from "cat" due to its large magnitude
```

### CLI usage

```bash
trovec init --dimensions 1536 --metric euclidean
```

## How to Choose

| Scenario | Recommended |
|---|---|
| Text embeddings (OpenAI, Sentence Transformers, etc.) | `cosine` — most models are optimized for this |
| Normalized vectors (unit length) | `dot` — equivalent to cosine but faster |
| Magnitude matters (e.g., TF-IDF, count-based features) | `euclidean` — accounts for vector length |
| Binary quantization at scale | `hamming` — fast bitwise comparison |
| Not sure | `cosine` — it is the safest default |

## Key Takeaways

- A metric defines how similarity between two vectors is calculated.
- Trovec supports four metrics: `cosine` (default), `euclidean`, `dot`, and `hamming`.
- All metrics return a similarity score where higher = more similar.
- Cosine measures direction only, euclidean measures distance, dot measures direction + magnitude, hamming counts matching bits.
- The right metric depends on your embedding model and data — cosine is the best default for most text embedding use cases.
- Hamming requires `BIT` quantization; the others work with `F32` and `INT8`.
