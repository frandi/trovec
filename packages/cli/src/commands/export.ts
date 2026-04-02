import { writeFileSync } from 'node:fs';
import type { Trovec, TrovecInstance } from '@trovec/core';
import { openDb } from '../db-manager.js';
import { formatOutput, detectFormat, success } from '../output.js';
import { buildFilterFn } from '../filter.js';
import type { CliFlags } from '../config.js';

export async function exportCommand(flags: CliFlags): Promise<void> {
  const db = await openDb(flags);
  const entries = getAllEntries(db);
  await db.close();

  // Apply filter
  let filtered = entries;
  if (flags.filter) {
    const filterFn = buildFilterFn(flags.filter as string);
    filtered = entries.filter((e) => filterFn(e.context));
  }

  const includeEmbedding = !!flags.embedding;
  const format = detectFormat(flags.format as string | undefined);

  const rows = filtered.map((e) => {
    const row: Record<string, unknown> = { id: e.id };
    if (e.context) row.context = e.context;
    if (includeEmbedding) row.embedding = e.embedding;
    return row;
  });

  const output = formatOutput(rows, format, { includeEmbedding });

  if (flags.output) {
    writeFileSync(flags.output as string, output + '\n');
    success(`Exported ${filtered.length} entries to ${flags.output}.`);
  } else {
    process.stdout.write(output + '\n');
  }
}

function getAllEntries(db: Trovec): Array<{ id: string; embedding: number[]; context?: Record<string, unknown> }> {
  const instance = db as unknown as TrovecInstance;
  const results: Array<{ id: string; embedding: number[]; context?: Record<string, unknown> }> = [];
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
