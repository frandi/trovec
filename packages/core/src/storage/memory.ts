import type { StorageDriver } from '../types.js';

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
