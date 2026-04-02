import type { Trovec, TrovecInstance } from '@trovec/core';
import { openDb } from '../db-manager.js';
import { formatOutput, detectFormat } from '../output.js';
import { CliError } from '../errors.js';
import { buildFilterFn } from '../filter.js';
import type { CliFlags } from '../config.js';

export async function findCommand(positionals: string[], flags: CliFlags): Promise<void> {
  const db = await openDb(flags);

  try {
    const entries = getAllEntries(db);

    // Apply filter if provided
    let filtered = entries;
    if (positionals[0]) {
      const filterFn = buildFilterFn(positionals[0]);
      filtered = entries.filter((e) => filterFn(e.context));
    }

    // Apply sort
    if (flags.sort) {
      const sortSpec = parseJson(flags.sort as string, '--sort');
      const sortEntries = Object.entries(sortSpec);
      filtered.sort((a, b) => {
        for (const [field, dir] of sortEntries) {
          const aVal = resolveField(a, field);
          const bVal = resolveField(b, field);
          const cmp = compare(aVal, bVal);
          if (cmp !== 0) return (dir as number) > 0 ? cmp : -cmp;
        }
        return 0;
      });
    }

    // Apply skip and limit
    const skip = (flags.skip as number | undefined) ?? 0;
    const limit = (flags.limit as number | undefined) ?? 50;
    const total = filtered.length;
    const page = filtered.slice(skip, skip + limit);

    const format = detectFormat(flags.format as string | undefined);
    const includeEmbedding = !!flags.embedding;

    const rows = page.map((e) => {
      const row: Record<string, unknown> = { id: String(e.id) };
      if (e.context) {
        for (const [key, val] of Object.entries(e.context)) {
          row[`context.${key}`] = val;
        }
      }
      if (includeEmbedding) {
        row.embedding = e.embedding;
      }
      return row;
    });

    process.stdout.write(formatOutput(rows, format, { includeEmbedding }) + '\n');

    if (format === 'table' && total > skip + limit) {
      process.stderr.write(`Showing ${skip + 1}-${skip + page.length} of ${total}. Use --skip and --limit to paginate.\n`);
    }

    await db.close();
  } catch (err) {
    await db.close();
    throw err;
  }
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
      results.push({
        id: String(entry.id),
        embedding: entry.embedding,
        context: entry.context,
      });
    }
  }
  return results;
}

function resolveField(entry: SimpleEntry, field: string): unknown {
  if (field === 'id') return entry.id;
  if (field.startsWith('context.')) {
    const path = field.slice(8);
    return getNestedValue(entry.context, path);
  }
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

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function parseJson(raw: string, flag: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new CliError(`Invalid JSON in ${flag}.`);
  }
}
