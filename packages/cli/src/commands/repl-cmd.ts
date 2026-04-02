import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import type { Trovec, TrovecInstance } from '@trovec/core';
import { openDb } from '../db-manager.js';
import { formatOutput } from '../output.js';
import { buildFilterFn } from '../filter.js';
import { CliError } from '../errors.js';
import type { CliFlags } from '../config.js';
import { getGlobalConfigDir } from '../config.js';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let outputFormat: 'table' | 'json' = 'table';

export async function replCommand(flags: CliFlags): Promise<void> {
  const db = await openDb(flags);
  const collectionId = db.config.collectionId;

  const historyDir = getGlobalConfigDir();
  if (!existsSync(historyDir)) mkdirSync(historyDir, { recursive: true });
  const historyPath = join(historyDir, 'repl_history');

  const rl = createInterface({
    input: stdin,
    output: stderr,
    prompt: `trovec:${collectionId}> `,
    history: loadHistory(historyPath),
    historySize: 500,
  });

  stderr.write(`Trovec REPL (${db.stats().entryCount} entries). Type .help for commands.\n`);
  rl.prompt();

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    try {
      if (trimmed.startsWith('.')) {
        const handled = handleMeta(trimmed);
        if (handled === 'exit') {
          await db.close();
          saveHistory(historyPath, rl);
          rl.close();
          return;
        }
      } else {
        await handleQuery(trimmed, db);
      }
    } catch (err) {
      stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    }

    rl.prompt();
  });

  rl.on('close', async () => {
    await db.close();
    saveHistory(historyPath, rl);
  });
}

function handleMeta(input: string): string | void {
  const parts = input.split(/\s+/);
  const cmd = parts[0];

  switch (cmd) {
    case '.help':
      stderr.write(`
Commands:
  db.find([filter])            Query entries with MongoDB-style filter
  db.count([filter])           Count matching entries
  db.distinct("field")         Unique values for a field
  db.stats()                   Collection statistics
  db.search("text")            Text similarity search
  db.search("text").topK(n)    Search with top-K
  db.get("id")                 Get entry by ID
  db.add({...})                Add entry: { id, text, context? }
  db.delete("id")              Delete entry
  db.embed("text")             Generate embedding

Meta:
  .format json|table           Set output format
  .clear                       Clear screen
  .help                        Show this help
  .exit                        Exit REPL
`);
      return;
    case '.exit':
      stderr.write('Bye.\n');
      return 'exit';
    case '.clear':
      stderr.write('\x1b[2J\x1b[H');
      return;
    case '.format':
      if (parts[1] === 'json' || parts[1] === 'table') {
        outputFormat = parts[1];
        stderr.write(`Output format set to ${outputFormat}.\n`);
      } else {
        stderr.write('Usage: .format json|table\n');
      }
      return;
    default:
      stderr.write(`Unknown meta-command "${cmd}". Type .help for commands.\n`);
      return;
  }
}

async function handleQuery(input: string, db: Trovec): Promise<void> {
  // db.stats()
  if (input.match(/^db\.stats\(\)$/)) {
    const s = db.stats();
    stdout.write(formatOutput(s as unknown as Record<string, unknown>, outputFormat) + '\n');
    return;
  }

  // db.get("id")
  const getMatch = input.match(/^db\.get\(["'](.+?)["']\)$/);
  if (getMatch) {
    const entry = db.get(getMatch[1]);
    if (!entry) {
      stderr.write(`Entry "${getMatch[1]}" not found.\n`);
      return;
    }
    const data: Record<string, unknown> = { id: String(entry.id) };
    if (entry.context) data.context = entry.context;
    stdout.write(formatOutput(data, outputFormat) + '\n');
    return;
  }

  // db.delete("id")
  const deleteMatch = input.match(/^db\.delete\(["'](.+?)["']\)$/);
  if (deleteMatch) {
    const ok = db.delete(deleteMatch[1]);
    stderr.write(ok ? `Deleted "${deleteMatch[1]}".\n` : `Entry "${deleteMatch[1]}" not found.\n`);
    return;
  }

  // db.count() or db.count({...})
  const countMatch = input.match(/^db\.count\((.*)\)$/);
  if (countMatch) {
    const entries = getAllEntries(db);
    let count: number;
    if (countMatch[1].trim()) {
      const filterFn = buildFilterFn(countMatch[1].trim());
      count = entries.filter((e) => filterFn(e.context)).length;
    } else {
      count = entries.length;
    }
    stdout.write(formatOutput({ count }, outputFormat) + '\n');
    return;
  }

  // db.distinct("field")
  const distinctMatch = input.match(/^db\.distinct\(["'](.+?)["']\)$/);
  if (distinctMatch) {
    const field = distinctMatch[1];
    const entries = getAllEntries(db);
    const values = new Set<string>();
    for (const e of entries) {
      const val = getNestedValue(e.context, field.startsWith('context.') ? field.slice(8) : field);
      if (val !== undefined) values.add(String(val));
    }
    const sorted = [...values].sort();
    stdout.write(sorted.join(', ') + '\n');
    return;
  }

  // db.embed("text")
  const embedMatch = input.match(/^db\.embed\(["'](.+?)["']\)$/);
  if (embedMatch) {
    const result = await db.embed(embedMatch[1]);
    stdout.write(formatOutput({ embedding: result.embedding }, outputFormat, { includeEmbedding: true }) + '\n');
    return;
  }

  // db.search("text") or db.search("text").topK(n)
  const searchMatch = input.match(/^db\.search\(["'](.+?)["']\)(?:\.topK\((\d+)\))?(?:\.filter\((.+)\))?$/);
  if (searchMatch) {
    const text = searchMatch[1];
    const topK = searchMatch[2] ? parseInt(searchMatch[2]) : 10;
    const filter = searchMatch[3] ? buildFilterFn(searchMatch[3]) : undefined;
    const results = await db.queryByText({ text, topK, filter });
    const rows = results.map((r) => ({
      id: String(r.id),
      score: Math.round(r.score * 10000) / 10000,
      ...r.context ? flattenContext(r.context) : {},
    }));
    stdout.write(formatOutput(rows, outputFormat) + '\n');
    return;
  }

  // db.add({...})
  const addMatch = input.match(/^db\.add\((\{.*\})\)$/);
  if (addMatch) {
    let parsed: { id: string; text?: string; embedding?: number[]; context?: Record<string, unknown> };
    try {
      parsed = JSON.parse(addMatch[1]);
    } catch {
      throw new CliError('Invalid JSON in db.add().');
    }
    if (parsed.text) {
      await db.addWithText({ id: parsed.id, text: parsed.text, context: parsed.context });
    } else if (parsed.embedding) {
      db.add({ id: parsed.id, embedding: parsed.embedding, context: parsed.context });
    } else {
      throw new CliError('Entry must have "text" or "embedding" field.');
    }
    stderr.write(`Added entry "${parsed.id}".\n`);
    return;
  }

  // db.find() or db.find({...}) with optional chaining
  const findMatch = input.match(/^db\.find\(([^)]*)\)(.*)$/);
  if (findMatch) {
    const entries = getAllEntries(db);
    let filtered = entries;

    if (findMatch[1].trim()) {
      const filterFn = buildFilterFn(findMatch[1].trim());
      filtered = entries.filter((e) => filterFn(e.context));
    }

    // Parse chain: .sort({...}).skip(n).limit(n)
    let skip = 0;
    let limit = 50;
    const chain = findMatch[2];

    const sortMatch = chain.match(/\.sort\((\{.*?\})\)/);
    if (sortMatch) {
      const sortSpec = JSON.parse(sortMatch[1]) as Record<string, number>;
      filtered.sort((a, b) => {
        for (const [field, dir] of Object.entries(sortSpec)) {
          const aVal = resolveField(a, field);
          const bVal = resolveField(b, field);
          const cmp = compare(aVal, bVal);
          if (cmp !== 0) return dir > 0 ? cmp : -cmp;
        }
        return 0;
      });
    }

    const skipMatch = chain.match(/\.skip\((\d+)\)/);
    if (skipMatch) skip = parseInt(skipMatch[1]);

    const limitMatch = chain.match(/\.limit\((\d+)\)/);
    if (limitMatch) limit = parseInt(limitMatch[1]);

    const total = filtered.length;
    const page = filtered.slice(skip, skip + limit);

    const rows = page.map((e) => {
      const row: Record<string, unknown> = { id: e.id };
      if (e.context) {
        for (const [key, val] of Object.entries(e.context)) {
          row[`context.${key}`] = val;
        }
      }
      return row;
    });

    stdout.write(formatOutput(rows, outputFormat) + '\n');
    if (total > skip + limit) {
      stderr.write(`Showing ${skip + 1}-${skip + page.length} of ${total}.\n`);
    }
    return;
  }

  stderr.write(`Unknown command. Type .help for available commands.\n`);
}

interface SimpleEntry {
  id: string;
  embedding: number[];
  context?: Record<string, unknown>;
}

function getAllEntries(db: Trovec): SimpleEntry[] {
  const instance = db as unknown as TrovecInstance;
  const results: SimpleEntry[] = [];
  for (const key of instance.entries.keys()) {
    const entry = db.get(key);
    if (entry) {
      results.push({ id: String(entry.id), embedding: entry.embedding, context: entry.context });
    }
  }
  return results;
}

function resolveField(entry: SimpleEntry, field: string): unknown {
  if (field === 'id') return entry.id;
  if (field.startsWith('context.')) return getNestedValue(entry.context, field.slice(8));
  return undefined;
}

function getNestedValue(obj: Record<string, unknown> | undefined, path: string): unknown {
  if (!obj) return undefined;
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function flattenContext(context: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(context)) {
    result[`context.${key}`] = val;
  }
  return result;
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function loadHistory(path: string): string[] {
  try {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function saveHistory(path: string, rl: ReturnType<typeof createInterface>): void {
  try {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    // readline exposes history as a property in Node 18+
    const history = (rl as unknown as { history?: string[] }).history;
    if (history) {
      writeFileSync(path, history.join('\n') + '\n');
    }
  } catch {
    // Best effort
  }
}
