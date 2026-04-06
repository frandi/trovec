<p align="center">
  <img src="./icon.png" alt="Trovec" width="128" height="128" />
</p>

# @trovec/cli

[![npm](https://img.shields.io/npm/v/@trovec/cli)](https://www.npmjs.com/package/@trovec/cli)

Command-line interface for the [Trovec](https://github.com/frandi/trovec) vector database. Perform all vector DB operations from the shell without writing code.

Built on top of the same `@trovec/core` packages used in code, so the CLI mirrors the programmatic API directly.

## Installation

```bash
npm install -g @trovec/cli
```

For OpenAI or Ollama embeddings, install the optional adapters:

```bash
npm install -g @trovec/embedder-openai
npm install -g @trovec/embedder-ollama
```

## Quick Start

```bash
# Initialize a project with the local embedder
trovec init --embedder local

# Add entries
trovec add doc-1 --text "Cats are curious animals" --context '{"category":"animals"}'
trovec add doc-2 --text "JavaScript is a programming language" --context '{"category":"programming"}'
trovec add doc-3 --text "Dogs are loyal pets" --context '{"category":"animals"}'

# Search by text similarity
trovec search "pets and animals" --top-k 2

# Query with filters
trovec search "pets" --filter '{"category":"animals"}'

# Browse entries
trovec find '{"category":"animals"}'

# Check collection stats
trovec stats

# Launch interactive REPL
trovec repl
```

## Working with Existing Databases

The CLI can open `.trovec` databases created programmatically (e.g., via `@trovec/core`) without requiring `trovec init`. When no `config.json` is present, the CLI automatically reads the database configuration (dimensions, quantization, metric) from the binary file header.

```bash
# Inspect a database created by another app — no config.json needed
cd my-app/
trovec stats
trovec find --limit 10

# If the app uses a non-default collection, specify it
trovec stats --collection my_collection
trovec find --collection my_collection
```

Embedder-dependent commands (`search`, `add --text`, `embed`) still require an embedder to be configured via `trovec config set`, flags, or environment variables.

## Commands

### Project Setup

#### `trovec init`

Initialize a new trovec project in the current directory.

```bash
trovec init --embedder local
trovec init --embedder openai --openai-key sk-...
trovec init --dimensions 768 --embedder ollama
trovec init --dimensions 128 --quantization INT8 --metric euclidean
```

| Option | Description |
|--------|-------------|
| `--dimensions <n>` | Vector dimensions (inferred from `--embedder` if omitted) |
| `--quantization <type>` | `F32` (default), `INT8`, or `BIT` |
| `--metric <type>` | `cosine` (default), `euclidean`, `dot`, or `hamming` |
| `--embedder <name>` | `local`, `openai`, or `ollama` |
| `--openai-key <key>` | OpenAI API key |
| `--ollama-url <url>` | Ollama server URL |
| `--ollama-model <model>` | Ollama model name |
| `--encryption-key <hex>` | Enable AES-256-GCM encryption with a 32-byte hex key |
| `--encryption-password <pass>` | Enable encryption with password-based key derivation (PBKDF2) |

Default dimensions per embedder: `local` = 64, `openai` = 1536, `ollama` = 768.

### Adding Entries

#### `trovec add`

Add a single entry.

```bash
# By text (requires embedder)
trovec add doc-1 --text "Hello world"
trovec add doc-1 --text "Hello world" --context '{"source":"greeting","lang":"en"}'

# From a text file
trovec add doc-1 --text-file ./article.txt --context '{"source":"blog"}'

# By raw embedding vector
trovec add doc-1 --embedding 0.1,0.2,0.3,0.4
```

#### `trovec add-many`

Add multiple entries from JSONL.

```bash
# From file
trovec add-many --file entries.jsonl

# From stdin
cat entries.jsonl | trovec add-many --stdin
echo '{"id":"a","text":"hello","context":{"lang":"en"}}
{"id":"b","text":"hola","context":{"lang":"es"}}' | trovec add-many --stdin
```

Each line must be a JSON object with `id` and either `text` or `embedding`, plus an optional `context`.

### Retrieving Entries

#### `trovec get`

```bash
trovec get doc-1
trovec get doc-1 --embedding          # include the vector
trovec get doc-1 --format json
```

### Deleting Entries

#### `trovec delete`

```bash
trovec delete doc-1
trovec delete --ids doc-1,doc-2,doc-3
```

### Searching

#### `trovec search`

Text similarity search (requires embedder).

```bash
trovec search "machine learning"
trovec search "cats" --top-k 5
trovec search "pets" --filter '{"category":"animals"}'
trovec search "hello" --format json | jq '.[0].id'
```

#### `trovec query`

Raw vector similarity search.

```bash
trovec query --vector 0.1,0.2,0.3 --top-k 5
trovec query --vector 0.1,0.2,0.3 --filter '{"category":"animals"}'
```

### Browsing

#### `trovec find`

MongoDB-style query on entries (no vector similarity, filters on metadata).

```bash
trovec find                                               # all entries
trovec find '{"category":"animals"}'                      # filter by field
trovec find '{"score":{"$gte":0.5}}' --sort '{"id":1}'   # filter + sort
trovec find --skip 10 --limit 5                           # pagination
```

Supported filter operators: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$regex`, `$exists`, `$and`, `$or`.

### Utilities

#### `trovec stats`

```bash
trovec stats
trovec stats --format json
```

#### `trovec flush`

Force persist pending changes to disk.

```bash
trovec flush
```

#### `trovec embed`

Generate an embedding vector for text.

```bash
trovec embed "hello world"
trovec embed "hello" --format json | jq '.embedding'
echo "hello" | trovec embed --stdin
```

#### `trovec inspect`

Read a raw `.trovec` binary file without opening a full database instance. Supports encrypted files when a key or password is provided.

```bash
trovec inspect .trovec/default.trovec
trovec inspect data.trovec --header --format json
trovec inspect data.trovec --encryption-password "my-secret"
```

#### `trovec migrate`

Migrate a collection between encryption states: encrypt, decrypt, rotate keys, upgrade format, or fast-rekey.

```bash
# Encrypt a plaintext collection
trovec migrate --source ./data --new-key "$KEY"

# Decrypt an encrypted collection
trovec migrate --source ./data --encryption-key "$KEY" --remove-encryption

# Rotate encryption key
trovec migrate --source ./data --encryption-key "$OLD_KEY" --new-key "$NEW_KEY"

# Fast rekey (O(1) header-only, v2 format required)
trovec migrate --source ./data --encryption-key "$OLD_KEY" --new-key "$NEW_KEY" --fast-rekey

# Upgrade v1 to v2 envelope format (same key)
trovec migrate --source ./data --encryption-key "$KEY" --new-key "$KEY" --upgrade-format

# Rotate with previous key fallback
trovec migrate --source ./data --encryption-key "$NEW_KEY" --previous-key "$OLD_KEY" --new-key "$NEW_KEY"
```

| Option | Description |
|--------|-------------|
| `--source <path>` | Source directory or file (required) |
| `--dest <path>` | Destination directory or file (default: source dir with suffix) |
| `--collection <id>` | Collection ID |
| `--new-key <hex>` | New encryption key for the destination |
| `--new-password <pass>` | New password for the destination |
| `--remove-encryption` | Write destination as plaintext |
| `--fast-rekey` | O(1) header-only rekey (v2 sources only, falls back if not possible) |
| `--upgrade-format` | Force v2 envelope format output (allows same-key migration) |
| `--previous-key <hex>` | Previous key for rolling rotation (fallback when primary fails) |
| `--previous-password <pass>` | Previous password for rolling rotation |
| `--force` | Overwrite existing destination file |
| `--no-verify` | Skip round-trip verification |

See the [migration guide](../../docs/migration/encryption-at-rest.md) for detailed walkthrough and examples.

### Bulk Import / Export

#### `trovec import`

```bash
trovec import data.jsonl
trovec import data.json --format json
cat data.jsonl | trovec import --stdin
```

#### `trovec export`

```bash
trovec export --format jsonl > backup.jsonl
trovec export --filter '{"category":"animals"}' --format json
trovec export --embedding --output full-backup.jsonl
```

Embeddings are excluded by default to keep output compact. Use `--embedding` to include them.

### Configuration

#### `trovec config`

Two-tier config: project-local (`.trovec/config.json`) overrides global (`~/.config/trovec/config.json`).

```bash
trovec config list                            # show merged config
trovec config get embedder                    # get a value
trovec config set embedder openai             # set in project config
trovec config set --global openaiApiKey sk-...  # set in global config
trovec config reset                           # remove project config
trovec config path                            # show config file locations
```

Environment variables are also supported:

| Variable | Description |
|----------|-------------|
| `TROVEC_DIR` | Storage directory (default: `.trovec/`) |
| `TROVEC_EMBEDDER` | Embedder name |
| `TROVEC_ENCRYPTION_KEY` | AES-256 encryption key (64 hex characters) |
| `TROVEC_ENCRYPTION_PASSWORD` | Password for PBKDF2 key derivation |
| `OPENAI_API_KEY` | OpenAI API key |
| `OLLAMA_BASE_URL` | Ollama server URL |

Resolution order: CLI flag > environment variable > project config > inferred from binary header > global config > default.

### Interactive REPL

#### `trovec repl`

Launch an interactive shell with MongoDB-style query language.

```
$ trovec repl
trovec:default> db.stats()
trovec:default> db.find({ "category": "animals" }).sort({ id: 1 }).limit(5)
trovec:default> db.search("curious creatures").topK(3)
trovec:default> db.count({ "category": { $in: ["animals", "pets"] } })
trovec:default> db.distinct("category")
trovec:default> db.add({ id: "new-1", text: "Testing the REPL", context: { source: "repl" } })
trovec:default> db.get("new-1")
trovec:default> db.delete("new-1")
trovec:default> db.embed("hello world")
trovec:default> .format json
trovec:default> .exit
```

Meta-commands: `.help`, `.exit`, `.format json|table`, `.clear`.

For encrypted projects, the REPL prompts for the password interactively (with hidden input) if it wasn't provided via `--encryption-key` / `--encryption-password` or the `TROVEC_ENCRYPTION_*` env vars. This avoids leaking passwords into shell history or `ps` output.

### Shell Completions

```bash
# Bash
eval "$(trovec completions bash)"
# or persist:
trovec completions bash >> ~/.bashrc

# Zsh
eval "$(trovec completions zsh)"

# Fish
trovec completions fish > ~/.config/fish/completions/trovec.fish
```

## Global Options

These options work with all commands:

| Option | Description |
|--------|-------------|
| `--dir <path>` | Storage directory (default: `.trovec/`) |
| `--collection <id>` | Collection ID (default: `default`) |
| `--format <fmt>` | Output format: `table`, `json`, `jsonl`, `csv` |
| `--encryption-key <hex>` | AES-256 encryption key (64 hex characters) |
| `--encryption-password <pass>` | Password for PBKDF2 key derivation |
| `--quiet` | Suppress status messages |
| `--help` | Show help for a command |
| `--version` | Show version |

Output format auto-detects: `table` when writing to a terminal, `json` when piped.

## CLI to API Mapping

| CLI Command | Trovec API |
|-------------|------------|
| `trovec init` | `create()` + `close()` |
| `trovec add --text` | `db.addWithText()` |
| `trovec add --embedding` | `db.add()` |
| `trovec add-many` | `db.addManyWithText()` / `db.addMany()` |
| `trovec get` | `db.get()` |
| `trovec delete` | `db.delete()` |
| `trovec search` | `db.queryByText()` |
| `trovec query` | `db.query()` |
| `trovec stats` | `db.stats()` |
| `trovec flush` | `db.flush()` |
| `trovec embed` | `db.embed()` |
| `trovec migrate` | `migrateCollection()` |

## License

MIT
