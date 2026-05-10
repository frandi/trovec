import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import {
  create,
  createConcurrentFileDriver,
  withEncryption,
} from '@trovec/core';
import type { Embedder, StorageDriver } from '@trovec/core';
import { createOpenAIEmbedder } from '@trovec/embedder-openai';
import { createEdgeEmbedder, type KnownModel } from '@trovec/embedder-edge';
import { createServer } from './server.js';

config();

const PORT = parseInt(process.env.PORT ?? '3737', 10);
const EMBEDDER_KIND = (process.env.EMBEDDER ?? 'edge').toLowerCase();
const EDGE_MODEL = (process.env.EDGE_MODEL ?? 'bge-base-en-v1.5') as KnownModel;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const ENCRYPTION_KEY_HEX = process.env.TROVEC_ENCRYPTION_KEY ?? '';
const ENCRYPTION_PASSWORD = process.env.TROVEC_ENCRYPTION_PASSWORD ?? '';

let embedder: Embedder;
let embedderLabel: string;
if (EMBEDDER_KIND === 'edge') {
  // Models other than the bundled bge-small are not shipped with
  // @trovec/embedder-edge. The benchmark downloads them into ./bench-models,
  // so we fall back to that directory for any non-bundled model.
  const benchPath = resolve(process.cwd(), 'bench-models', EDGE_MODEL);
  const modelPath = EDGE_MODEL !== 'bge-small-en-v1.5' && existsSync(benchPath)
    ? benchPath
    : undefined;
  if (EDGE_MODEL !== 'bge-small-en-v1.5' && !modelPath) {
    console.error(
      `Error: model "${EDGE_MODEL}" is not bundled and was not found at ${benchPath}. ` +
      `Run \`npm run benchmark\` once to download bench models, or set EDGE_MODEL=bge-small-en-v1.5.`,
    );
    process.exit(1);
  }
  embedder = createEdgeEmbedder({ model: EDGE_MODEL, modelPath });
  embedderLabel = `edge (${embedder.model})`;
} else if (EMBEDDER_KIND === 'openai') {
  if (!OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY is required when EMBEDDER=openai.');
    process.exit(1);
  }
  embedder = createOpenAIEmbedder({ apiKey: OPENAI_API_KEY });
  embedderLabel = `openai (${embedder.model})`;
} else {
  console.error(`Error: unsupported EMBEDDER="${EMBEDDER_KIND}". Use "edge" or "openai".`);
  process.exit(1);
}

if (!OPENAI_API_KEY) {
  console.warn(
    'Warning: OPENAI_API_KEY not set. Ingest, /api/search, and /api/documents work; ' +
    '/api/ask will fail until you set the key (the LLM answer-generation step needs OpenAI).',
  );
}

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

// Use an embedder-dim-aware collection ID so each embedder has its own
// persisted file. Switching embedders never corrupts or fails to load
// the previous collection — both files coexist, and the UI can offer
// to re-ingest the prior documents using the current embedder.
const COLLECTION_ID = `trovec-${embedder.dimensions}d`;

const db = await create({
  embedder,
  storageDriver,
  collectionId: COLLECTION_ID,
});

console.log(`Embedder: ${embedderLabel}`);
console.log(`Collection: ${COLLECTION_ID}`);
console.log('Storage: ConcurrentFileDriver + WAL');
console.log(`Encryption at rest: ${encryptionLabel}`);

const server = createServer(db, OPENAI_API_KEY, PORT);

process.on('SIGINT', async () => {
  await db.close();
  server.close();
  process.exit(0);
});
