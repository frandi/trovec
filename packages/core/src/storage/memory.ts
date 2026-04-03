import type { StorageDriver } from '../types.js';

/**
 * Create an in-memory storage driver.
 *
 * Data is stored in a `Map` and lost when the process exits. Useful for testing,
 * ephemeral caches, or when persistence is handled externally via {@link serialize}.
 *
 * @returns A {@link StorageDriver} backed by an in-memory Map.
 */
export function createMemoryDriver(): StorageDriver {
  const store = new Map<string, Buffer>();

  return {
    async write(collectionId: string, data: Buffer): Promise<void> {
      store.set(collectionId, data);
    },

    async read(collectionId: string): Promise<Buffer | null> {
      return store.get(collectionId) ?? null;
    },

    async exists(collectionId: string): Promise<boolean> {
      return store.has(collectionId);
    },

    async delete(collectionId: string): Promise<boolean> {
      return store.delete(collectionId);
    },
  };
}
