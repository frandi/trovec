import { readFileSync } from 'node:fs';
import { openDb } from '../db-manager.js';
import { CliError } from '../errors.js';
import { success, info } from '../output.js';
import type { CliFlags } from '../config.js';

export async function addCommand(positionals: string[], flags: CliFlags): Promise<void> {
  const id = positionals[0];
  if (!id) {
    throw new CliError('Entry ID is required.', 'Usage: trovec add <id> --text "..." [--context \'{}\']');
  }

  const context = flags.context ? parseContext(flags.context as string) : undefined;
  const db = await openDb(flags);

  try {
    if (flags.text || flags['text-file']) {
      const text = flags['text-file']
        ? readFileSync(flags['text-file'] as string, 'utf-8')
        : flags.text as string;

      if (!text) {
        throw new CliError('No text provided.', 'Use --text "..." or --text-file <path>.');
      }

      info(`Embedding and adding entry "${id}"...`);
      await db.addWithText({ id, text, context });
    } else if (flags.embedding) {
      const embedding = parseEmbedding(flags.embedding as string);
      db.add({ id, embedding, context });
    } else {
      throw new CliError(
        'Either --text, --text-file, or --embedding is required.',
        'Usage: trovec add <id> --text "Hello world"',
      );
    }

    await db.close();
    success(`Added entry "${id}".`);
  } catch (err) {
    await db.close();
    throw err;
  }
}

export async function addManyCommand(flags: CliFlags): Promise<void> {
  let input: string;

  if (flags.stdin) {
    input = await readStdin();
  } else if (flags.file) {
    input = readFileSync(flags.file as string, 'utf-8');
  } else {
    throw new CliError(
      'Input source is required.',
      'Use --file <path> or --stdin.',
    );
  }

  const lines = input.trim().split('\n').filter((l) => l.trim());
  const entries = lines.map((line, i) => {
    try {
      return JSON.parse(line) as { id: string; text?: string; embedding?: number[]; context?: Record<string, unknown> };
    } catch {
      throw new CliError(`Invalid JSON on line ${i + 1}.`);
    }
  });

  const db = await openDb(flags);

  try {
    const hasText = entries.some((e) => e.text);
    const hasEmbedding = entries.some((e) => e.embedding);

    if (hasText) {
      const textEntries = entries.map((e) => ({
        id: e.id,
        text: e.text!,
        context: e.context,
      }));
      info(`Embedding and adding ${textEntries.length} entries...`);
      await db.addManyWithText(textEntries);
    } else if (hasEmbedding) {
      const vectorEntries = entries.map((e) => ({
        id: e.id,
        embedding: e.embedding!,
        context: e.context,
      }));
      db.addMany(vectorEntries);
    } else {
      throw new CliError('Entries must have either "text" or "embedding" field.');
    }

    await db.close();
    success(`Added ${entries.length} entries.`);
  } catch (err) {
    await db.close();
    throw err;
  }
}

function parseContext(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new CliError(
      'Invalid JSON in --context.',
      'Provide valid JSON, e.g. --context \'{"key":"value"}\'',
    );
  }
}

function parseEmbedding(raw: string): number[] {
  const parts = raw.split(',').map((s) => parseFloat(s.trim()));
  if (parts.some(isNaN)) {
    throw new CliError(
      'Invalid embedding format.',
      'Provide comma-separated numbers, e.g. --embedding 0.1,0.2,0.3',
    );
  }
  return parts;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
