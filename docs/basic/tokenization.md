# Tokenization

## Tokenization and Embeddings

The [embeddings guide](./embeddings.md) intentionally treats the embedding model as a black box: *you send text in and get a vector out.* That framing is enough to start using Trovec. But there is one part of what happens inside that box that has visible consequences for you as a developer: **tokenization**.

An embedding model never processes raw text. Before any numbers are produced, your text is converted into a sequence of integers — a step called tokenization. Understanding it matters because it introduces a hard limit on how much text the model can process at once. That limit, and what happens when you exceed it, directly affects how you prepare documents for embedding.

## What Is a Token?

A **token** is the model's basic unit of text. Tokens are not characters, and they are not whole words — they are **subword units**: pieces of text drawn from a fixed vocabulary that the model was trained with.

The tokenizer breaks your text by matching the longest known pieces from its vocabulary. Common English words usually stay whole. Rare words, technical terms, and identifiers get split into smaller fragments:

```
"cat"            →  ["cat"]                          (1 token)
"embeddings"     →  ["em", "##bed", "##dings"]       (3 tokens)
"tokenization"   →  ["token", "##ization"]           (2 tokens)
"XK2-7B"         →  ["x", "##k", "##2", "-", "7", "##b"]  (6 tokens)
```

The `##` prefix marks a **continuation piece** — a fragment that attaches to the previous token rather than starting a new word. This is what allows the tokenizer to reconstruct word boundaries after splitting.

Subword tokenization exists because the two simpler alternatives both fail at scale:

- **Characters only**: sequences become very long, and individual characters carry almost no meaning.
- **Whole words only**: the vocabulary grows enormous, and any word not seen during training becomes unknown.

Subwords find the middle ground: a compact vocabulary that can represent any text, including words the model has never seen.

## Special Tokens

Every input is automatically wrapped with two tokens that the model expects structurally:

- `[CLS]` — prepended at the start. Signals the beginning of a sequence.
- `[SEP]` — appended at the end. Signals the end of a sequence.

These are not part of your text. But they consume token slots, which matters for the limit discussed in the next section.

```
Input text:  "The cat"
Tokens:      [CLS]  The  cat  [SEP]
Count:          1    1    1     1   =  4 tokens total (2 content + 2 special)
```

## The Token Limit

Every model has a maximum sequence length — a cap on how many tokens it can accept in a single input. For `bge-small-en-v1.5` and `bge-base-en-v1.5`, that cap is **512 tokens**.

The limit is architectural. The model's positional encodings are trained for a fixed number of positions and cannot generalize beyond them.

Since `[CLS]` and `[SEP]` always occupy 2 slots, your content has a working limit of **510 tokens**.

Tokens and words are not the same length. As a rough guide for English prose:

| Content | Approximate token count |
|---|---|
| 1 short common word | 1 token |
| 1 average word | ~1.3 tokens |
| 1 sentence (~15 words) | ~20 tokens |
| 1 paragraph (~100 words) | ~130 tokens |
| 1 page (~400 words) | ~520 tokens |

A single page of ordinary prose already exceeds the 510-token content limit. Technical writing — code snippets, URLs, identifiers, product codes — tokenizes even less efficiently, so you hit the limit sooner.

## What Happens When Text Is Too Long

When an input exceeds the token limit, the tokenizer **silently truncates** — everything past token 510 is dropped. No error is thrown, no warning is returned.

```
Input:     "word₁ word₂ word₃ ... word₆₀₀"   (~780 tokens)
                                                      ↓
Processed: [CLS] word₁ word₂ ... word₅₁₀ [SEP]   (512 tokens kept)
Dropped:   word₄₁₁ ... word₆₀₀                    (silently discarded)
```

The resulting embedding captures only the beginning of your text. If the most relevant content is in the middle or near the end, it will not be reflected in the vector at all. The embedding looks valid — it is just incomplete in a way that produces no visible signal.

## Chunking: The Practical Response

The standard solution is to split long documents into smaller pieces — called **chunks** — before embedding. Each chunk stays within the token limit, so the full document is represented across multiple embeddings rather than truncated into one.

```
Long document (2000 words, ~2600 tokens)
       ↓ split into overlapping chunks of ~300 words
Chunk 1:  words 1–300       →  embedding A
Chunk 2:  words 251–550     →  embedding B
Chunk 3:  words 501–800     →  embedding C
...
```

A small overlap between consecutive chunks — typically 50 to 100 words — prevents losing context at boundaries. A sentence that sits at the edge of one chunk appears fully within the next.

In Trovec, each chunk becomes a separate entry. At query time, search runs across all chunks and surfaces the most relevant passage — not just the most relevant document. This is exactly what the [embeddings guide](./embeddings.md) shows in its PDF example:

```ts
const chunks = extractChunksFromPDF('manual.pdf');

await db.addManyWithText(
  chunks.map((chunk, i) => ({
    id: `manual:p${chunk.page}:c${i}`,
    text: chunk.text,   // each chunk is short enough to embed fully
    context: {
      page: chunk.page,
      source: 'manual.pdf',
      preview: chunk.text.slice(0, 200),
    },
  }))
);
```

The chunking step is there precisely because of the token limit. Now you know why.

Size your chunks to stay well within 510 tokens — a target of around 300 words per chunk gives comfortable headroom across both prose and technical content.

## Common Misconceptions

### "1 token = 1 word"

Not quite. Familiar English words are often 1 token, but anything less common — technical terms, names, abbreviations, non-English text — splits into multiple tokens per word. A rough word count will underestimate your token usage. When it matters, count tokens directly.

### "Long text is fully embedded"

No. Text beyond 510 content tokens is silently dropped. If your input is longer than roughly 380 words of prose, the tail is gone. There is nothing in the returned embedding to indicate truncation occurred.

### "I need to manage tokenization manually"

The embedder handles tokenization internally — you pass text, it does everything else. But understanding the token limit tells you *when* you need to chunk, and understanding truncation tells you *what goes wrong* if you don't.

## How Tokenization Connects to Other Concepts

Tokenization sits at the entrance of the embedding pipeline. After the token sequence is produced, the model generates the vector that all the other concepts operate on.

- **[Embeddings](./embeddings.md)** — Tokenization is the input stage of embedding. The embedding captures the meaning of the complete token sequence the model receives.
- **[Dimensions](./dimensions.md)** — The output vector length is fixed by the model architecture and has no relationship to the number of input tokens.
- **[Quantization](./quantization.md)** — Quantization compresses the output embedding for storage. It operates on the vector after it is produced and is unrelated to tokenization.

## Key Takeaways

- Tokenization converts text into a sequence of integers before the embedding model processes it.
- Tokens are subword units — not characters, not whole words.
- Every input is wrapped with `[CLS]` and `[SEP]`, consuming 2 of the 512 available slots.
- The effective content limit is **510 tokens** — roughly 380 words of English prose.
- Text beyond the limit is **silently truncated**; only the beginning influences the embedding.
- For documents longer than ~380 words, split into chunks before embedding.
