# Pooling

## Pooling and Embeddings

The [tokenization guide](./tokenization.md) explains the input side of producing an embedding — how raw text is converted into a sequence of integer token IDs before the model runs. Pooling is the output side: the step that takes what the model produces and turns it into the single vector you store and search.

That step is necessary because transformers don't naturally produce one vector per input. They produce one vector per *token*. Pooling is how those per-token outputs get collapsed into one.

```
"The cat sat"
       ↓ tokenization
[CLS]  The  cat  sat  [SEP]        (5 tokens)
       ↓ transformer
 [v₁]  [v₂] [v₃] [v₄]  [v₅]      (5 vectors, one per token)
       ↓ pooling
             [v]                    (1 vector — the embedding)
```

## The Problem: One Vector per Token

A transformer processes each token in context of all the others and outputs a **hidden state** — a vector — for each position. For a 5-token input you get 5 hidden state vectors. For a 50-token input you get 50.

This is valuable for tasks like question answering or named entity recognition, where you need to reason about individual words. For embedding — where the goal is a single representation of the whole input — you need to reduce those N vectors to one.

The choice of how to perform that reduction is called **pooling**.

## Mean Pooling

The approach used by BGE-family models (including both models in embedder-edge) is **mean pooling**: average the hidden state vectors across all real token positions.

```
Token:         [CLS]    The    cat    sat   [SEP]
Hidden state:   [v₁]   [v₂]   [v₃]   [v₄]   [v₅]
                                 ↓
Mean pooling:  average(v₁, v₂, v₃, v₄, v₅)  →  [v_mean]
```

The word *real* matters here. When multiple inputs are processed together in a batch, shorter sequences are padded with dummy tokens to match the length of the longest one. Those padding tokens carry no content from your text and should not influence the result.

The attention mask from tokenization — 1 for real tokens, 0 for padding — is exactly the signal pooling uses to know which positions to include:

```
Input A (padded):  [CLS]  The  cat  [SEP]  [PAD]  [PAD]
Attention mask:      1     1    1     1      0      0
                                 ↓
Mean pooling:  average positions where mask = 1 only
```

Padding is excluded from the average, so batch size and the position of an input within a batch have no effect on its embedding.

## L2 Normalization

Mean pooling produces a single vector, but with an arbitrary magnitude — the length of the vector varies depending on the input. **L2 normalization** scales the vector to unit length (magnitude exactly 1) by dividing each value by the vector's overall length:

```
Pooled:      [1.2,  1.6]   (length = 2.0)
Normalized:  [0.6,  0.8]   (divided by 2.0)

Pooled:      [0.3,  0.4]   (length = 0.5)
Normalized:  [0.6,  0.8]   (divided by 0.5)
```

Both pooled vectors point in the same direction but have different magnitudes. After normalization they become identical. Direction is preserved; scale is discarded.

## Why Unit Length Matters

Normalizing to unit length has a specific consequence for how similarity is calculated.

**Cosine similarity** measures the angle between two vectors — vectors pointing in the same direction score 1.0, opposite directions score −1.0. It does this by dividing the dot product by both vectors' magnitudes:

```
cosine(a, b) = dot(a, b) / (‖a‖ × ‖b‖)
```

When both vectors have unit length (‖a‖ = ‖b‖ = 1), the denominator becomes 1 and drops out:

```
cosine(a, b) = dot(a, b)
```

Cosine similarity becomes a plain dot product — one of the fastest operations in vector search. The [metric guide](./metric.md) describes when to use cosine; now you know where the unit-norm property that makes it efficient comes from.

## Common Misconceptions

### "The [CLS] token is the sentence embedding"

This is true for some models but not for BGE-family models. BERT's original design used the `[CLS]` token's hidden state as a sentence-level representation, which worked well for classification tasks the model was fine-tuned for. BGE models are trained specifically for retrieval, and mean pooling over all real tokens consistently outperforms using `[CLS]` alone for that task.

Both approaches produce a valid sentence embedding. The difference lies in what the model was trained to encode into those positions. For embedder-edge's default model, mean pooling is the correct choice.

### "Longer inputs produce better embeddings"

Not necessarily. Mean pooling averages across all real tokens, so a very long input dilutes the contribution of any individual token — including the most relevant ones. A focused input often produces a more useful embedding than a long one with significant off-topic content. This is another reason chunking is preferable to passing entire documents as-is.

## How Pooling Connects to Other Concepts

Pooling sits between tokenization and the final embedding vector — it is the step that closes the pipeline.

- **[Tokenization](./tokenization.md)** — Tokenization produces the token sequence and the attention mask that pooling uses to exclude padding positions.
- **[Embeddings](./embeddings.md)** — The output of pooling is the embedding. Pooling is the last step before you have the vector that Trovec stores and searches.
- **[Metric](./metric.md)** — L2 normalization makes cosine similarity equal to a dot product. The metric guide covers when to use cosine; pooling is why it is the natural default for BGE embeddings.
- **[Dimensions](./dimensions.md)** — The size of the pooled vector equals the model's hidden dimension: 384 for `bge-small-en-v1.5`, 768 for `bge-base-en-v1.5`. The number of input tokens has no effect on this size.

## Key Takeaways

- Transformers produce one hidden state vector per token; pooling reduces them to one vector per input.
- **Mean pooling** averages the hidden states of real tokens, using the attention mask to exclude padding.
- **L2 normalization** scales the pooled vector to unit length by dividing by its magnitude.
- Unit-norm vectors make cosine similarity equal to a plain dot product — efficient and exact.
- BGE models use mean pooling rather than the `[CLS]` token because they are trained for retrieval tasks.
- Longer inputs are not always better; focused inputs often embed more usefully than long, unfocused ones.
