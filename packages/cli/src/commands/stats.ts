import { openDb } from '../db-manager.js';
import { formatOutput, detectFormat } from '../output.js';
import type { CliFlags } from '../config.js';

export async function statsCommand(flags: CliFlags): Promise<void> {
  const db = await openDb(flags);
  const s = db.stats();
  await db.close();

  const format = detectFormat(flags.format as string | undefined);
  const data: Record<string, unknown> = {
    entryCount: s.entryCount,
    dimensions: s.dimensions,
    quantization: s.quantization,
    metric: s.metric,
    indexStatus: s.indexStatus,
  };

  process.stdout.write(formatOutput(data, format) + '\n');
}
