import { openDb } from '../db-manager.js';
import { formatOutput, detectFormat } from '../output.js';
import { CliError } from '../errors.js';
import type { CliFlags } from '../config.js';

export async function embedCommand(positionals: string[], flags: CliFlags): Promise<void> {
  let text: string;

  if (flags.stdin) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    text = Buffer.concat(chunks).toString('utf-8').trim();
  } else {
    text = positionals[0] ?? '';
  }

  if (!text) {
    throw new CliError('Text is required.', 'Usage: trovec embed "some text" or echo "text" | trovec embed --stdin');
  }

  const db = await openDb(flags);
  const result = await db.embed(text);
  await db.close();

  const format = detectFormat(flags.format as string | undefined);
  const data = { embedding: result.embedding };

  process.stdout.write(formatOutput(data, format, { includeEmbedding: true }) + '\n');
}
