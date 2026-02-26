import type { VCoreInstance, Entry, EntryId } from './types.js';
import { validateEntry, validateEntries, serializeId } from './validation.js';

export function add(instance: VCoreInstance, entry: Entry): void {
  validateEntry(entry, instance.config.dimensions);

  const quantized = instance.codec.encode(entry.embedding);
  const key = serializeId(entry.id);

  instance.entries.set(key, {
    id: entry.id,
    quantized,
    context: entry.context,
  });

  instance.dirty = true;
}

export function addMany(instance: VCoreInstance, entries: Entry[]): void {
  // Validate ALL entries before any mutation (atomic)
  validateEntries(entries, instance.config.dimensions);

  // Quantize all embeddings
  const prepared = entries.map((entry) => ({
    key: serializeId(entry.id),
    stored: {
      id: entry.id,
      quantized: instance.codec.encode(entry.embedding),
      context: entry.context,
    },
  }));

  // Insert all
  for (const { key, stored } of prepared) {
    instance.entries.set(key, stored);
  }

  if (entries.length > 0) {
    instance.dirty = true;
  }
}

export function del(instance: VCoreInstance, id: EntryId): boolean {
  const key = serializeId(id);
  const existed = instance.entries.delete(key);

  if (existed) {
    instance.dirty = true;
  }

  return existed;
}

export function get(instance: VCoreInstance, id: EntryId): Entry | undefined {
  const key = serializeId(id);
  const stored = instance.entries.get(key);

  if (!stored) return undefined;

  return {
    id: stored.id,
    embedding: instance.codec.decode(stored.quantized),
    context: stored.context,
  };
}
