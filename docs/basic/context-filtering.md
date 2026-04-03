# Context Filtering

## The Question

If similarity search already finds results by meaning, why would you need traditional filtering?

This is a common question for beginners. The answer comes down to a fundamental distinction: **similarity tells you what is related, but it cannot enforce hard constraints.**

## The Problem Similarity Search Cannot Solve

Imagine a multi-tenant document search application. You have documents from Company A and Company B stored in the same collection. A user from Company A searches for "quarterly revenue report."

With similarity search alone:

```
Query: "quarterly revenue report"

Results:
  1. Company B — Q3 Revenue Report  (score: 0.95)  ← wrong tenant!
  2. Company A — Q4 Revenue Summary  (score: 0.93)
  3. Company A — Annual Revenue Overview  (score: 0.88)
```

The most semantically similar document belongs to Company B. Similarity search has no concept of access control — it just finds the closest vectors. Returning Company B's confidential data to a Company A user would be a serious problem.

No amount of rewording the query will fix this. The vectors for "quarterly revenue report" from both companies are genuinely similar because they discuss the same topic. **Similarity is not a substitute for business logic.**

## What Is Context Filtering?

Context filtering lets you attach **metadata** (called `context` in Trovec) to each vector and then apply **deterministic predicates** at query time to include or exclude entries before they are ranked.

```
Vector  = what the content means     (fuzzy, approximate)
Context = facts about the content    (exact, deterministic)
```

The filter runs on the context metadata, not on the vector. It answers yes/no questions like:
- Does this document belong to the current tenant?
- Is this content in the requested language?
- Was this published after a certain date?
- Does this entry match a specific category?

## How It Works in Trovec

### Step 1: Attach context when adding entries

```ts
await db.addWithText({
  id: 'doc-1',
  text: 'Q4 Revenue Summary for fiscal year 2024',
  context: {
    tenant: 'company-a',
    category: 'finance',
    year: 2024,
    language: 'en',
  },
});

await db.addWithText({
  id: 'doc-2',
  text: 'Q3 Revenue Report with regional breakdown',
  context: {
    tenant: 'company-b',
    category: 'finance',
    year: 2024,
    language: 'en',
  },
});
```

### Step 2: Apply a filter when querying

```ts
const results = await db.queryByText({
  text: 'quarterly revenue report',
  topK: 5,
  filter: (ctx) => ctx?.tenant === 'company-a',
});

// Only returns documents from Company A
// Company B's documents are excluded before ranking
```

The filter is a plain JavaScript function that receives the entry's context and returns `true` (include) or `false` (exclude). Entries that fail the filter are skipped entirely — they do not appear in results and do not count toward `topK`.

### Combining multiple conditions

Since the filter is a regular function, you can combine conditions freely:

```ts
// English finance documents from 2024
const results = await db.queryByText({
  text: 'revenue trends',
  topK: 10,
  filter: (ctx) =>
    ctx?.language === 'en' &&
    ctx?.category === 'finance' &&
    (ctx?.year as number) >= 2024,
});
```

## When to Use Context Filtering

### Use filtering for hard constraints

These are conditions that **must** be true regardless of relevance:

| Constraint | Example filter |
|---|---|
| Tenant isolation | `ctx?.tenantId === currentTenant` |
| Access control | `ctx?.accessLevel <= userLevel` |
| Language | `ctx?.language === 'en'` |
| Date range | `(ctx?.date as number) >= startDate` |
| Content type | `ctx?.type === 'article'` |
| Status | `ctx?.published === true` |

### Let similarity handle soft preferences

These are qualities where "close enough" is acceptable:

- Topic relevance ("find documents about machine learning")
- Semantic similarity ("find questions similar to this one")
- Tone or style (captured implicitly by the embedding model)

### The combination is powerful

The best results come from using both together: filtering narrows the search space to valid candidates, and similarity ranks those candidates by relevance.

```
All entries
  └─ Context filter → valid candidates only
       └─ Similarity search → ranked by relevance
            └─ Top K → final results
```

## Practical Examples

### Multi-source document search

A PDF search system with documents from multiple files:

```ts
// During ingestion
await db.addManyWithText(
  chunks.map((chunk, i) => ({
    id: `${fileName}:c${i}`,
    text: chunk.text,
    context: {
      sourceFile: fileName,
      page: chunk.page,
    },
  }))
);

// Search only within a specific document
const results = await db.queryByText({
  text: 'installation instructions',
  topK: 5,
  filter: (ctx) => ctx?.sourceFile === 'user-manual.pdf',
});
```

### Category-scoped search

A knowledge base with tagged articles:

```ts
await db.addWithText({
  id: 'article-42',
  text: 'Cats are curious creatures that love to explore...',
  context: { category: 'animals' },
});

// Only search within the animals category
const results = await db.queryByText({
  text: 'curious creatures',
  topK: 5,
  filter: (ctx) => ctx?.category === 'animals',
});
```

### Time-bounded search

Only return recent content:

```ts
const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;

const results = await db.queryByText({
  text: 'deployment best practices',
  topK: 5,
  filter: (ctx) => (ctx?.createdAt as number) >= oneYearAgo,
});
```

## What to Store in Context

Keep context lightweight and focused on values you will actually filter on:

**Good context fields:**
- Identifiers: `tenantId`, `userId`, `sourceFile`
- Categories: `type`, `category`, `language`
- Dates: `createdAt`, `year`
- Flags: `published`, `archived`

**Avoid storing in context:**
- Large text blobs (store those externally and reference by ID)
- Data you will never filter on (adds storage overhead for no benefit)

## Key Takeaways

- Similarity search finds what is **related** — it cannot enforce **rules**.
- Context filtering applies deterministic, exact constraints (tenant, language, date, etc.) that similarity cannot guarantee.
- In Trovec, you attach a `context` object to each entry and pass a `filter` function at query time.
- Filtered entries are excluded entirely — they do not appear in results or count toward `topK`.
- The best search combines both: filtering for correctness, similarity for relevance.
