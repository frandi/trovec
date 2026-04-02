import { openDb } from '../db-manager.js';
import { formatOutput, detectFormat, info } from '../output.js';
import { CliError } from '../errors.js';
import { buildFilterFn } from '../filter.js';
import type { CliFlags } from '../config.js';

export async function searchCommand(positionals: string[], flags: CliFlags): Promise<void> {
  const text = positionals[0];
  if (!text) {
    throw new CliError('Search text is required.', 'Usage: trovec search "query text"');
  }

  const topK = (flags['top-k'] as number | undefined) ?? 10;
  const filter = flags.filter ? buildFilterFn(flags.filter as string) : undefined;

  const db = await openDb(flags);

  info(`Searching for "${text}"...`);
  const results = await db.queryByText({ text, topK, filter });
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
