import type { TrovecInstance, Entry, EntryId } from './types.js';
import { validateEntry, validateEntries, serializeId } from './validation.js';

/**
 * Add a single vector entry to the collection.
 *
 * The embedding is quantized and stored internally. If auto-flush is enabled,
 * a debounced persist is scheduled.
 *
 * @param instance - The Trovec instance.
 * @param entry - The entry to add. Its embedding length must match configured dimensions.
 * @throws {DimensionMismatchError} If the embedding length does not match.
 * @throws {InvalidConfigError} If the entry is malformed (missing id or embedding).
 */
export function add(instance: TrovecInstance, entry: Entry): void {
  validateEntry(entry, instance.config.dimensions);

  const quantized = instance.codec.encode(entry.embedding);
  const key = serializeId(entry.id);

  instance.entries.set(key, {
    id: entry.id,
    quantized,
    context: entry.context,
  });

  instance._walBuffer?.push({ type: 'put', id: entry.id, quantized, context: entry.context });
  instance.dirty = true;
  instance._scheduleFlush?.();
}

/**
 * Add multiple vector entries in a single atomic batch.
 *
 * All entries are validated before any mutations occur. If validation fails for
 * any entry, no entries are inserted (all-or-nothing semantics).
 *
 * @param instance - The Trovec instance.
 * @param entries - Array of entries to add.
 * @throws {DimensionMismatchError} If any embedding length does not match.
 * @throws {InvalidConfigError} If any entry is malformed.
 */
export function addMany(instance: TrovecInstance, entries: Entry[]): void {
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
    instance._walBuffer?.push({ type: 'put', id: stored.id, quantized: stored.quantized, context: stored.context });
  }

  if (entries.length > 0) {
    instance.dirty = true;
    instance._scheduleFlush?.();
  }
}

/**
 * Delete an entry by its ID.
 *
 * @param instance - The Trovec instance.
 * @param id - The ID of the entry to remove.
 * @returns `true` if the entry existed and was removed, `false` otherwise.
 */
export function del(instance: TrovecInstance, id: EntryId): boolean {
  const key = serializeId(id);
  const existed = instance.entries.delete(key);

  if (existed) {
    instance._walBuffer?.push({ type: 'delete', id });
    instance.dirty = true;
    instance._scheduleFlush?.();
  }

  return existed;
}

/**
 * Retrieve an entry by its ID, decoding the stored quantized vector back to floats.
 *
 * @param instance - The Trovec instance.
 * @param id - The ID of the entry to retrieve.
 * @returns The entry with its decoded embedding, or `undefined` if not found.
 */
export function get(instance: TrovecInstance, id: EntryId): Entry | undefined {
  const key = serializeId(id);
  const stored = instance.entries.get(key);

  if (!stored) return undefined;

  return {
    id: stored.id,
    embedding: instance.codec.decode(stored.quantized),
    context: stored.context,
  };
}
