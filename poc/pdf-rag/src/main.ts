import { config } from 'dotenv';
import { create } from '@trovec/core';
import { createOllamaEmbedder } from '@trovec/embedder-ollama';
import { createServer } from './server.js';

config();

const PORT = parseInt(process.env.PORT ?? '3737', 10);
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'nomic-embed-text';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';

if (!OPENAI_API_KEY) {
  console.warn('Warning: OPENAI_API_KEY is not set. The /api/ask endpoint will not work.');
}

const embedder = createOllamaEmbedder({
  model: OLLAMA_MODEL,
  baseUrl: OLLAMA_URL,
});

const db = create({
  dimensions: 768,
  metric: 'cosine',
  embedder,
});

console.log(`Using Ollama embedder (${OLLAMA_MODEL}) at ${OLLAMA_URL}`);

createServer(db, OPENAI_API_KEY, PORT);
