import { openDb } from '../db-manager.js';
import { formatOutput, detectFormat } from '../output.js';
import { CliError } from '../errors.js';
import { buildFilterFn } from '../filter.js';
import type { CliFlags } from '../config.js';

export async function queryCommand(flags: CliFlags): Promise<void> {
  if (!flags.vector) {
    throw new CliError(
      'Query vector is required.',
      'Usage: trovec query --vector 0.1,0.2,0.3 [--top-k N]',
    );
  }

  const vector = (flags.vector as string).split(',').map((s) => parseFloat(s.trim()));
  if (vector.some(isNaN)) {
    throw new CliError('Invalid vector format.', 'Provide comma-separated numbers.');
  }

  const topK = (flags['top-k'] as number | undefined) ?? 10;
  const filter = flags.filter ? buildFilterFn(flags.filter as string) : undefined;

  const db = await openDb(flags);
  const results = db.query({ vector, topK, filter });
  await db.close();

  const format = detectFormat(flags.format as string | undefined);
  const rows = results.map((r) => ({
    id: String(r.id),
    score: Math.round(r.score * 10000) / 10000,
    ...r.context ? flattenContext(r.context) : {},
  }));

  process.stdout.write(formatOutput(rows, format, { includeEmbedding: !!flags.embedding }) + '\n');
}

function flattenContext(context: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(context)) {
    result[`context.${key}`] = val;
  }
  return result;
}
