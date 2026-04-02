import { openDb } from '../db-manager.js';
import { formatOutput, detectFormat } from '../output.js';
import { CliError } from '../errors.js';
import type { CliFlags } from '../config.js';

export async function getCommand(positionals: string[], flags: CliFlags): Promise<void> {
  const id = positionals[0];
  if (!id) {
    throw new CliError('Entry ID is required.', 'Usage: trovec get <id>');
  }

  const db = await openDb(flags);
  const entry = db.get(id);
  await db.close();

  if (!entry) {
    throw new CliError(`Entry "${id}" not found.`);
  }

  const format = detectFormat(flags.format as string | undefined);
  const data: Record<string, unknown> = {
    id: String(entry.id),
    ...entry.context ? { context: entry.context } : {},
  };

  if (flags.embedding) {
    data.embedding = entry.embedding;
  }

  process.stdout.write(formatOutput(data, format) + '\n');
}
