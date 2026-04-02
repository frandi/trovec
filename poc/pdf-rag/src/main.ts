import { config } from 'dotenv';
import { create, createFileDriver } from '@trovec/core';
import { createOpenAIEmbedder } from '@trovec/embedder-openai';
import { createServer } from './server.js';

config();

const PORT = parseInt(process.env.PORT ?? '3737', 10);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';

if (!OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY is required.');
  process.exit(1);
}

const embedder = createOpenAIEmbedder({ apiKey: OPENAI_API_KEY });

const db = await create({
  embedder,
  storageDriver: createFileDriver(),
});

console.log('Using OpenAI embedder (text-embedding-3-small)');

const server = createServer(db, OPENAI_API_KEY, PORT);

process.on('SIGINT', async () => {
  await db.close();
  server.close();
  process.exit(0);
});
