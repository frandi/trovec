import { openDb } from '../db-manager.js';
import { CliError } from '../errors.js';
import { success } from '../output.js';
import type { CliFlags } from '../config.js';

export async function deleteCommand(positionals: string[], flags: CliFlags): Promise<void> {
  const ids: string[] = [];

  if (positionals[0]) {
    ids.push(positionals[0]);
  }

  if (flags.ids) {
    ids.push(...(flags.ids as string).split(',').map((s) => s.trim()));
  }

  if (ids.length === 0) {
    throw new CliError(
      'At least one entry ID is required.',
      'Usage: trovec delete <id> or trovec delete --ids id1,id2,id3',
    );
  }

  const db = await openDb(flags);
  let deleted = 0;
  const notFound: string[] = [];

  for (const id of ids) {
    if (db.delete(id)) {
      deleted++;
    } else {
      notFound.push(id);
    }
  }

  await db.close();

  if (deleted > 0) {
    success(`Deleted ${deleted} ${deleted === 1 ? 'entry' : 'entries'}.`);
  }

  if (notFound.length > 0) {
    process.stderr.write(`Not found: ${notFound.join(', ')}\n`);
  }
}
