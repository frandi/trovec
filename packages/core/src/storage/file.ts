import { writeFile, readFile, access, unlink, rename, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import type { FileStorageDriver, FileDriverOptions } from '../types.js';

const DEFAULT_DIRECTORY = '.trovec';

export function createFileDriver(options: FileDriverOptions = {}): FileStorageDriver {
  const { directory = DEFAULT_DIRECTORY, compression = true, compressionLevel = 1 } = options;
  const resolvedDir = resolve(directory);

  let dirEnsured = false;

  async function ensureDir(): Promise<void> {
    if (dirEnsured) return;
    await mkdir(resolvedDir, { recursive: true });
    dirEnsured = true;
  }

  function filePath(collectionId: string): string {
    return join(resolvedDir, `${collectionId}.trovec`);
  }

  function compress(data: Buffer): Buffer {
    if (!compression) return data;
    return brotliCompressSync(data, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: compressionLevel,
      },
    });
  }

  function decompress(data: Buffer): Buffer {
    if (!compression) return data;
    return brotliDecompressSync(data);
  }

  return {
    get directory() {
      return resolvedDir;
    },

    async write(collectionId: string, data: Buffer): Promise<void> {
      await ensureDir();
      const target = filePath(collectionId);
      const tmp = `${target}.tmp`;
      const compressed = compress(data);
      await writeFile(tmp, compressed);
      await rename(tmp, target);
    },

    async read(collectionId: string): Promise<Buffer | null> {
      try {
        const raw = await readFile(filePath(collectionId));
        return decompress(raw);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },

    async exists(collectionId: string): Promise<boolean> {
      try {
        await access(filePath(collectionId));
        return true;
      } catch {
        return false;
      }
    },

    async delete(collectionId: string): Promise<boolean> {
      try {
        await unlink(filePath(collectionId));
        return true;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw err;
      }
    },

    async destroy(): Promise<void> {
      await rm(resolvedDir, { recursive: true, force: true });
      dirEnsured = false;
    },
  };
}
