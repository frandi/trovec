# Trovec Viewer for VS Code

A VS Code extension for viewing and querying `.trovec` vector database files directly in the editor.

## Features

- **Custom editor** — opens `.trovec` files with a visual interface instead of raw binary
- **MongoDB-style queries** — familiar fluent syntax for browsing, filtering, and aggregating data
- **Autocomplete** — context-aware suggestions for commands, operators, and field paths from your data
- **Live reload** — automatically refreshes when the `.trovec` file changes on disk

## Usage

1. Open any `.trovec` file in VS Code
2. The Trovec Viewer opens automatically
3. Type a query and press **Ctrl+Enter** (or click **Run**)

## Query Reference

### Commands

```js
db.find()                                         // all entries (paginated)
db.find({ id: "doc-1" })                          // find by exact ID
db.find({ id: { $regex: "^doc-" } })              // ID pattern match
db.find({ "context.category": "news" })           // filter by context field
db.find({ "context.score": { $gt: 0.5 } })       // comparison operators
db.count()                                        // total entry count
db.count({ "context.type": "article" })           // filtered count
db.distinct("context.category")                   // unique values for a field
db.stats()                                        // collection metadata
```

### Chaining

```js
db.find({ "context.type": "article" })
  .sort({ "context.date": -1 })                   // sort (1 = asc, -1 = desc)
  .skip(20)                                        // offset
  .limit(10)                                       // max results
```

### Filter Operators

| Operator   | Description              | Example                                        |
| ---------- | ------------------------ | ---------------------------------------------- |
| *(none)*   | Exact match              | `{ "context.type": "article" }`                |
| `$gt`      | Greater than             | `{ "context.score": { $gt: 0.5 } }`           |
| `$gte`     | Greater than or equal    | `{ "context.score": { $gte: 0.5 } }`          |
| `$lt`      | Less than                | `{ "context.score": { $lt: 1.0 } }`           |
| `$lte`     | Less than or equal       | `{ "context.score": { $lte: 0.9 } }`          |
| `$ne`      | Not equal                | `{ "context.status": { $ne: "draft" } }`      |
| `$in`      | In array                 | `{ id: { $in: ["a", "b"] } }`                 |
| `$nin`     | Not in array             | `{ "context.type": { $nin: ["draft"] } }`     |
| `$regex`   | Pattern match (case-insensitive) | `{ "context.title": { $regex: "^intro" } }` |
| `$exists`  | Field exists             | `{ "context.tags": { $exists: true } }`       |
| `$and`     | Logical AND              | `{ $and: [{ ... }, { ... }] }`                |
| `$or`      | Logical OR               | `{ $or: [{ ... }, { ... }] }`                 |

Multiple fields in one object are implicitly `$and`:

```js
db.find({ "context.type": "article", "context.score": { $gte: 0.8 } })
```

### Result Table

- Click any row to expand it and see the full context JSON, embedding values, and vector stats (min, max, mean, L2 norm)
- Results are paginated at 50 rows per page

## Development

```bash
# Install dependencies
npm install

# Compile
npm run build

# Launch in VS Code
# Press F5 (uses the "Run Trovec Viewer Extension" launch config)
```

## File Format

The extension reads `.trovec` binary files (with optional Brotli compression) produced by [@trovec/core](../core). It supports all quantization types (F32, INT8, BIT) and metrics (cosine, euclidean, dot, hamming).
