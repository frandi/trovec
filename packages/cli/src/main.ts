import { parseArgs } from 'node:util';
import { handleError, CliError } from './errors.js';
import type { CliFlags } from './config.js';
import { VERSION } from './version.js';

const HELP = `
Usage: trovec <command> [options]

Commands:
  init            Initialize a new trovec project
  add             Add an entry
  add-many        Add multiple entries from file or stdin
  get             Get an entry by ID
  delete          Delete entries
  search          Text similarity search
  query           Vector similarity search
  find            MongoDB-style query on entries
  stats           Show collection statistics
  flush           Force persist to disk
  embed           Generate embedding for text
  import          Import entries from file
  export          Export entries
  inspect         Read raw .trovec file
  migrate         Copy a collection to a new file, adding/removing/rotating encryption
  config          Manage configuration
  repl            Interactive REPL
  completions     Generate shell completions

Global Options:
  --dir <path>                  Storage directory (default: .trovec/)
  --collection <id>             Collection ID (default: default)
  --format <fmt>                Output format: table, json, jsonl, csv
  --encryption-key <hex>        AES-256 key (64 hex chars) or TROVEC_ENCRYPTION_KEY env
  --encryption-password <pass>  Password for key derivation or TROVEC_ENCRYPTION_PASSWORD env
  --quiet                       Suppress status messages
  --help                        Show help
  --version                     Show version

Run "trovec <command> --help" for command-specific help.
`.trim();

const COMMAND_HELP: Record<string, string> = {
  init: `
Usage: trovec init [options]

Initialize a new trovec project in the current directory.

Options:
  --dimensions <n>             Vector dimensions (required unless --embedder is set)
  --quantization <type>        F32, INT8, or BIT (default: F32)
  --metric <type>              cosine, euclidean, dot, or hamming (default: cosine)
  --embedder <name>            Embedder: local, openai, ollama
  --openai-key <key>           OpenAI API key
  --ollama-url <url>           Ollama server URL
  --ollama-model <model>       Ollama model name
  --encryption-key <hex>       Enable encryption with a 32-byte hex key
  --encryption-password <pass> Enable encryption with a password (PBKDF2)

Examples:
  trovec init --dimensions 64 --embedder local
  trovec init --embedder openai --openai-key sk-...
  trovec init --dimensions 128 --quantization INT8 --metric euclidean
  trovec init --dimensions 384 --encryption-password "my-secret"`.trim(),

  add: `
Usage: trovec add <id> [options]

Add a single entry to the collection.

Options:
  --text <string>              Text to embed (requires embedder)
  --text-file <path>           Read text from file
  --embedding <floats>         Comma-separated embedding values
  --context <json>             JSON metadata object

Examples:
  trovec add doc-1 --text "Hello world" --context '{"category":"greeting"}'
  trovec add doc-2 --text-file ./article.txt
  trovec add doc-3 --embedding 0.1,0.2,0.3,0.4`.trim(),

  'add-many': `
Usage: trovec add-many [options]

Add multiple entries from a file or stdin.
Input format: JSONL with {id, text?, embedding?, context?} per line.

Options:
  --file <path>                Read entries from JSONL file
  --stdin                      Read entries from stdin

Examples:
  trovec add-many --file entries.jsonl
  cat data.jsonl | trovec add-many --stdin`.trim(),

  get: `
Usage: trovec get <id> [options]

Retrieve an entry by ID.

Options:
  --embedding                  Include embedding vector in output

Examples:
  trovec get doc-1
  trovec get doc-1 --embedding --format json`.trim(),

  delete: `
Usage: trovec delete <id> [options]
       trovec delete --ids <id1,id2,...>

Delete one or more entries.

Options:
  --ids <list>                 Comma-separated list of IDs to delete

Examples:
  trovec delete doc-1
  trovec delete --ids doc-1,doc-2,doc-3`.trim(),

  search: `
Usage: trovec search <text> [options]

Similarity search by text (requires embedder).

Options:
  --top-k <n>                  Number of results (default: 10)
  --filter <json>              MongoDB-style filter on context fields
  --embedding                  Include embedding vectors in output

Examples:
  trovec search "machine learning"
  trovec search "cats" --top-k 5 --filter '{"context.category":"animals"}'
  trovec search "hello" --format json | jq '.[0].id'`.trim(),

  query: `
Usage: trovec query [options]

Similarity search by vector.

Options:
  --vector <floats>            Comma-separated query vector (required)
  --top-k <n>                  Number of results (default: 10)
  --filter <json>              MongoDB-style filter on context fields
  --embedding                  Include embedding vectors in output

Examples:
  trovec query --vector 0.1,0.2,0.3 --top-k 5`.trim(),

  find: `
Usage: trovec find [filter] [options]

MongoDB-style query on entries (no vector similarity).

Options:
  --sort <json>                Sort specification, e.g. '{"id":1}'
  --skip <n>                   Number of entries to skip
  --limit <n>                  Maximum entries to return (default: 50)
  --embedding                  Include embedding vectors in output

Examples:
  trovec find
  trovec find '{"context.category":"animals"}'
  trovec find '{"context.score":{"$gte":0.5}}' --sort '{"id":1}' --limit 10`.trim(),

  stats: `
Usage: trovec stats

Show collection statistics (entry count, dimensions, quantization, metric).

Examples:
  trovec stats
  trovec stats --format json`.trim(),

  flush: `
Usage: trovec flush

Force persist pending changes to disk.`.trim(),

  embed: `
Usage: trovec embed <text> [options]
       trovec embed --stdin

Generate an embedding vector for text (requires embedder).

Options:
  --stdin                      Read text from stdin

Examples:
  trovec embed "hello world"
  trovec embed "hello" --format json | jq '.embedding'
  echo "hello" | trovec embed --stdin`.trim(),

  import: `
Usage: trovec import <file> [options]
       trovec import --stdin [options]

Bulk import entries from a file or stdin.

Options:
  --stdin                      Read from stdin
  --format <fmt>               Input format: jsonl (default), json

Examples:
  trovec import data.jsonl
  trovec import data.json --format json
  cat data.jsonl | trovec import --stdin`.trim(),

  export: `
Usage: trovec export [options]

Export entries from the collection.

Options:
  --output <path>              Write to file instead of stdout
  --filter <json>              MongoDB-style filter
  --embedding                  Include embedding vectors
  --format <fmt>               Output format: jsonl (default), json, csv

Examples:
  trovec export --format jsonl > backup.jsonl
  trovec export --filter '{"context.category":"animals"}' --format json`.trim(),

  inspect: `
Usage: trovec inspect <file>

Read a raw .trovec file and display its contents.

Options:
  --header                     Show only header information
  --encryption-key <hex>       Decrypt with a 32-byte hex key
  --encryption-password <pass> Decrypt with a password

Examples:
  trovec inspect .trovec/default.trovec
  trovec inspect data.trovec --header --format json
  trovec inspect data.trovec --encryption-key abc123...`.trim(),

  migrate: `
Usage: trovec migrate --source <dir-or-file> [--dest <dir-or-file>] [options]

Non-destructively copy a collection to a new .trovec file, optionally adding,
removing, or rotating AES-256-GCM encryption at rest. The source file is left
byte-identical. Any pending WAL entries in the source are checkpointed into
the destination so the dest is a single clean base file with no sidecar.

The app must be stopped before running this command. If a .lock file is found
next to the source, migration is refused.

Source resolution:
  --source <file.trovec>       Use this file directly.
  --source <dir>               Auto-detect the single .trovec file in the dir.
                               If multiple exist, pass --source <file.trovec>
                               or --collection <id>.

Destination resolution:
  --dest <file.trovec>         Write to exactly this path.
  --dest <dir>                 Write into this directory using the default name
                               "<source-name>-enc.trovec" (or "-dec"/"-rekeyed"
                               depending on the operation).
  (omitted)                    Write next to the source with the default name.

Options:
  --source <path>              Source directory or .trovec file (required)
  --dest <path>                Destination directory or .trovec file (optional)
  --collection <id>            Disambiguate when the source directory has multiple .trovec files
  --encryption-key <hex>       Source key — use when the source is already encrypted
  --encryption-password <pass> Source password — alternative to --encryption-key
  --new-key <hex>              Destination key (32-byte hex) — encrypt the dest
  --new-password <pass>        Destination password (PBKDF2) — alternative to --new-key
  --remove-encryption          Write the destination as plaintext (recovery path)
  --force                      Overwrite the destination collection file if it exists
  --no-verify                  Skip round-trip verification (not recommended)

Examples:
  # Enable encryption in place (writes ./.trovec/default-enc.trovec)
  trovec migrate --source ./.trovec --new-key $(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

  # Explicit source file, explicit dest file
  trovec migrate --source ./.trovec/default.trovec --dest ./.trovec/default-v2.trovec --new-password "correct horse battery staple"

  # Rotate the encryption key into the same directory
  trovec migrate --source ./.trovec/default.trovec --encryption-key <old-hex> --new-key <new-hex>

  # Decrypt back to plaintext (recovery)
  trovec migrate --source ./.trovec/default.trovec --encryption-key <hex> --remove-encryption`.trim(),

  config: `
Usage: trovec config <subcommand> [args]

Manage trovec configuration.

Subcommands:
  list                         Show merged configuration
  get <key>                    Get a config value
  set <key> <value>            Set a project config value
  set --global <key> <value>   Set a global config value
  reset                        Remove project config
  path                         Show config file locations

Examples:
  trovec config list
  trovec config get embedder
  trovec config set embedder openai
  trovec config set --global openaiApiKey sk-...`.trim(),

  repl: `
Usage: trovec repl

Launch interactive REPL with MongoDB-style query language.

For encrypted projects, the REPL will prompt for the password
interactively if no --encryption-key / --encryption-password or
TROVEC_ENCRYPTION_* env var is provided.

Commands in REPL:
  db.find([filter])            Query entries
  db.count([filter])           Count entries
  db.distinct("field")         Unique field values
  db.stats()                   Collection statistics
  db.search("text")            Text similarity search
  db.get("id")                 Get entry by ID
  db.add({...})                Add entry
  db.delete("id")              Delete entry
  .help                        Show help
  .exit                        Exit REPL`.trim(),

  completions: `
Usage: trovec completions <shell>

Generate shell completion script.

Supported shells: bash, zsh, fish

Examples:
  trovec completions bash >> ~/.bashrc
  eval "$(trovec completions bash)"`.trim(),
};

// All options that parseArgs needs to know about across all commands.
// parseArgs is strict by default, so we declare everything here.
const OPTIONS_CONFIG = {
  // Global
  dir: { type: 'string' as const },
  collection: { type: 'string' as const },
  format: { type: 'string' as const },
  quiet: { type: 'boolean' as const },
  help: { type: 'boolean' as const },
  version: { type: 'boolean' as const },
  // init
  dimensions: { type: 'string' as const },
  quantization: { type: 'string' as const },
  metric: { type: 'string' as const },
  embedder: { type: 'string' as const },
  'openai-key': { type: 'string' as const },
  'openai-model': { type: 'string' as const },
  'openai-base-url': { type: 'string' as const },
  'ollama-url': { type: 'string' as const },
  'ollama-model': { type: 'string' as const },
  // add
  text: { type: 'string' as const },
  'text-file': { type: 'string' as const },
  embedding: { type: 'string' as const },
  context: { type: 'string' as const },
  // add-many / import / embed
  file: { type: 'string' as const },
  stdin: { type: 'boolean' as const },
  // query / search
  vector: { type: 'string' as const },
  'top-k': { type: 'string' as const },
  filter: { type: 'string' as const },
  // delete
  ids: { type: 'string' as const },
  // find
  sort: { type: 'string' as const },
  skip: { type: 'string' as const },
  limit: { type: 'string' as const },
  // export
  output: { type: 'string' as const },
  // inspect
  header: { type: 'boolean' as const },
  // config
  global: { type: 'boolean' as const },
  // encryption
  'encryption-key': { type: 'string' as const },
  'encryption-password': { type: 'string' as const },
  // migrate
  source: { type: 'string' as const },
  dest: { type: 'string' as const },
  'new-key': { type: 'string' as const },
  'new-password': { type: 'string' as const },
  'remove-encryption': { type: 'boolean' as const },
  force: { type: 'boolean' as const },
  'no-verify': { type: 'boolean' as const },
};

function parseCliArgs(argv: string[]): { command: string; positionals: string[]; flags: CliFlags } {
  const { values, positionals } = parseArgs({
    args: argv.slice(2),
    options: OPTIONS_CONFIG,
    allowPositionals: true,
    strict: false,
  });

  const command = positionals[0] ?? '';
  const restPositionals = positionals.slice(1);

  // Convert numeric string flags
  const flags = { ...values } as CliFlags;
  if (typeof flags.dimensions === 'string') flags.dimensions = parseInt(flags.dimensions, 10);
  if (typeof flags['top-k'] === 'string') flags['top-k'] = parseInt(flags['top-k'], 10);
  if (typeof flags.skip === 'string') flags.skip = parseInt(flags.skip as string, 10);
  if (typeof flags.limit === 'string') flags.limit = parseInt(flags.limit as string, 10);

  return { command, positionals: restPositionals, flags };
}

async function run(): Promise<void> {
  const { command, positionals, flags } = parseCliArgs(process.argv);

  if (flags.version) {
    process.stdout.write(`trovec v${VERSION}\n`);
    return;
  }

  if (!command || flags.help && !command) {
    process.stdout.write(HELP + '\n');
    return;
  }

  if (flags.help) {
    const help = COMMAND_HELP[command];
    if (help) {
      process.stdout.write(help + '\n');
    } else {
      process.stdout.write(`No help available for "${command}".\n`);
    }
    return;
  }

  switch (command) {
    case 'init': {
      const { initCommand } = await import('./commands/init.js');
      await initCommand(flags);
      break;
    }

    case 'stats': {
      const { statsCommand } = await import('./commands/stats.js');
      await statsCommand(flags);
      break;
    }

    case 'add': {
      const { addCommand } = await import('./commands/add.js');
      await addCommand(positionals, flags);
      break;
    }

    case 'add-many': {
      const { addManyCommand } = await import('./commands/add.js');
      await addManyCommand(flags);
      break;
    }

    case 'get': {
      const { getCommand } = await import('./commands/get.js');
      await getCommand(positionals, flags);
      break;
    }

    case 'delete': {
      const { deleteCommand } = await import('./commands/delete.js');
      await deleteCommand(positionals, flags);
      break;
    }

    case 'search': {
      const { searchCommand } = await import('./commands/search.js');
      await searchCommand(positionals, flags);
      break;
    }

    case 'query': {
      const { queryCommand } = await import('./commands/query.js');
      await queryCommand(flags);
      break;
    }

    case 'find': {
      const { findCommand } = await import('./commands/find.js');
      await findCommand(positionals, flags);
      break;
    }

    case 'flush': {
      const { flushCommand } = await import('./commands/flush.js');
      await flushCommand(flags);
      break;
    }

    case 'embed': {
      const { embedCommand } = await import('./commands/embed.js');
      await embedCommand(positionals, flags);
      break;
    }

    case 'import': {
      const { importCommand } = await import('./commands/import.js');
      await importCommand(positionals, flags);
      break;
    }

    case 'export': {
      const { exportCommand } = await import('./commands/export.js');
      await exportCommand(flags);
      break;
    }

    case 'inspect': {
      const { inspectCommand } = await import('./commands/inspect.js');
      await inspectCommand(positionals, flags);
      break;
    }

    case 'migrate': {
      const { migrateCommand } = await import('./commands/migrate.js');
      await migrateCommand(positionals, flags);
      break;
    }

    case 'config': {
      const { configCommand } = await import('./commands/config-cmd.js');
      await configCommand(positionals, flags);
      break;
    }

    case 'repl': {
      const { replCommand } = await import('./commands/repl-cmd.js');
      await replCommand(flags);
      break;
    }

    case 'completions': {
      const { completionsCommand } = await import('./commands/completions-cmd.js');
      await completionsCommand(positionals, flags);
      break;
    }

    default:
      throw new CliError(
        `Unknown command "${command}".`,
        `Run "trovec --help" to see available commands.`,
      );
  }
}

run().catch(handleError);
