import { openDb } from '../db-manager.js';
import { success } from '../output.js';
import type { CliFlags } from '../config.js';

export async function flushCommand(flags: CliFlags): Promise<void> {
  const db = await openDb(flags);
  await db.flush();
  await db.close();
  success('Flushed to disk.');
}
