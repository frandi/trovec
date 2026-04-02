import { readFileSync } from 'node:fs';
import { openDb } from '../db-manager.js';
import { CliError } from '../errors.js';
import { success, info } from '../output.js';
import type { CliFlags } from '../config.js';

export async function importCommand(positionals: string[], flags: CliFlags): Promise<void> {
  let input: string;

  if (flags.stdin) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    input = Buffer.concat(chunks).toString('utf-8');
  } else {
    const file = positionals[0];
    if (!file) {
      throw new CliError('File path is required.', 'Usage: trovec import <file> or trovec import --stdin');
    }
    input = readFileSync(file, 'utf-8');
  }

  const format = (flags.format as string | undefined) ?? 'jsonl';
  let entries: Array<{ id: string; text?: string; embedding?: number[]; context?: Record<string, unknown> }>;

  if (format === 'json') {
    try {
      entries = JSON.parse(input) as typeof entries;
      if (!Array.isArray(entries)) {
        throw new CliError('JSON input must be an array of entries.');
      }
    } catch (err) {
      if (err instanceof CliError) throw err;
      throw new CliError('Invalid JSON input.');
    }
  } else {
    // JSONL
    const lines = input.trim().split('\n').filter((l) => l.trim());
    entries = lines.map((line, i) => {
      try {
        return JSON.parse(line) as (typeof entries)[0];
      } catch {
        throw new CliError(`Invalid JSON on line ${i + 1}.`);
      }
    });
  }

  if (entries.length === 0) {
    throw new CliError('No entries found in input.');
  }

  const db = await openDb(flags);

  try {
    const hasText = entries.some((e) => e.text);

    if (hasText) {
      const textEntries = entries.map((e) => ({
        id: e.id,
        text: e.text!,
        context: e.context,
      }));
      info(`Embedding and importing ${textEntries.length} entries...`);
      await db.addManyWithText(textEntries);
    } else {
      const vectorEntries = entries.map((e) => ({
        id: e.id,
        embedding: e.embedding!,
        context: e.context,
      }));
      db.addMany(vectorEntries);
    }

    await db.close();
    success(`Imported ${entries.length} entries.`);
  } catch (err) {
    await db.close();
    throw err;
  }
}
