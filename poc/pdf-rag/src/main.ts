import { config } from 'dotenv';
import {
  create,
  createConcurrentFileDriver,
  withEncryption,
} from '@trovec/core';
import type { StorageDriver } from '@trovec/core';
import { createOpenAIEmbedder } from '@trovec/embedder-openai';
import { createServer } from './server.js';

config();

const PORT = parseInt(process.env.PORT ?? '3737', 10);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const ENCRYPTION_KEY_HEX = process.env.TROVEC_ENCRYPTION_KEY ?? '';
const ENCRYPTION_PASSWORD = process.env.TROVEC_ENCRYPTION_PASSWORD ?? '';

if (!OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY is required.');
  process.exit(1);
}

const embedder = createOpenAIEmbedder({ apiKey: OPENAI_API_KEY });

// Concurrent file driver: safe for multi-process access (file locking + WAL).
// PDF uploads can write concurrently without corrupting the store.
const fileDriver = createConcurrentFileDriver({ wal: true });

// Optional AES-256-GCM encryption at rest. Set one of:
//   TROVEC_ENCRYPTION_KEY      — 64-char hex (32 raw bytes)
//   TROVEC_ENCRYPTION_PASSWORD — passphrase (PBKDF2-derived)
let storageDriver: StorageDriver = fileDriver;
let encryptionLabel = 'disabled';
if (ENCRYPTION_KEY_HEX) {
  if (ENCRYPTION_KEY_HEX.length !== 64) {
    console.error('Error: TROVEC_ENCRYPTION_KEY must be 64 hex characters (32 bytes).');
    process.exit(1);
  }
  storageDriver = withEncryption(fileDriver, { key: Buffer.from(ENCRYPTION_KEY_HEX, 'hex') });
  encryptionLabel = 'AES-256-GCM (raw key)';
} else if (ENCRYPTION_PASSWORD) {
  storageDriver = withEncryption(fileDriver, { password: ENCRYPTION_PASSWORD });
  encryptionLabel = 'AES-256-GCM (password-derived)';
}

const db = await create({
  embedder,
  storageDriver,
});

console.log('Using OpenAI embedder (text-embedding-3-small)');
console.log('Storage: ConcurrentFileDriver + WAL');
console.log(`Encryption at rest: ${encryptionLabel}`);

const server = createServer(db, OPENAI_API_KEY, PORT);

process.on('SIGINT', async () => {
  await db.close();
  server.close();
  process.exit(0);
});
