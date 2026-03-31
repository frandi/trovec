import {
  create,
  createMemoryDriver,
  createFileDriver,
} from '@trovec/core';
import type { Embedder } from '@trovec/core';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createLocalEmbedder } from '@trovec/embedder-local';
import { createOpenAIEmbedder } from '@trovec/embedder-openai';
import { createOllamaEmbedder } from '@trovec/embedder-ollama';
import DOCUMENTS from './documents.json' with { type: 'json' };

// ─── ANSI Helpers ─────────────────────────────────────────────────────────────

const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  magenta: '\x1b[35m',
  blue:    '\x1b[34m',
  red:     '\x1b[31m',
  white:   '\x1b[37m',
  gray:    '\x1b[90m',
  bgCyan:  '\x1b[46m',
  bgGreen: '\x1b[42m',
};

const INDENT = '  ';
const WIDTH = 64;
const LINE = c.dim + '─'.repeat(WIDTH) + c.reset;

function banner() {
  console.log();
  console.log(c.cyan + c.bold + '  ╔' + '═'.repeat(WIDTH - 2) + '╗' + c.reset);
  console.log(c.cyan + c.bold + '  ║' + ' '.repeat(18) + 'Trovec CLI Demo' + ' '.repeat(WIDTH - 34) + '║' + c.reset);
  console.log(c.cyan + c.bold + '  ║' + c.reset + c.cyan + ' '.repeat(10) + 'Vector Database Library for Node.js' + ' '.repeat(WIDTH - 47) + c.bold + '║' + c.reset);
  console.log(c.cyan + c.bold + '  ╚' + '═'.repeat(WIDTH - 2) + '╝' + c.reset);
  console.log();
}

function step(num: number, title: string) {
  console.log();
  console.log(`${INDENT}${c.bgCyan}${c.bold} STEP ${num} ${c.reset} ${c.bold}${title}${c.reset}`);
  console.log(`${INDENT}${LINE}`);
}

function info(label: string, value: string) {
  console.log(`${INDENT}  ${c.gray}${label}:${c.reset} ${value}`);
}

function bullet(text: string) {
  console.log(`${INDENT}  ${c.dim}›${c.reset} ${text}`);
}

function success(text: string) {
  console.log(`${INDENT}  ${c.green}✓${c.reset} ${text}`);
}

function warn(text: string) {
  console.log(`${INDENT}  ${c.yellow}⚠${c.reset} ${text}`);
}

function resultRow(rank: number, id: string, score: number, context?: Record<string, unknown>) {
  const scoreStr = score.toFixed(4);
  const ctx = context ? c.dim + ' ' + JSON.stringify(context) + c.reset : '';
  console.log(`${INDENT}  ${c.bold}${c.yellow}#${rank}${c.reset}  ${c.cyan}${id}${c.reset}  ${c.green}score=${scoreStr}${c.reset}${ctx}`);
}

function embeddingPreview(embedding: number[]): string {
  const preview = embedding.slice(0, 5).map((v) => v.toFixed(4)).join(', ');
  return `[${preview}, ... ] ${c.dim}(${embedding.length} dims)${c.reset}`;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Demo Data ────────────────────────────────────────────────────────────────

const QUERIES = [
  { text: 'pets and animals',       description: 'Broad animal query' },
  { text: 'JavaScript programming', description: 'Programming topic' },
  { text: 'similarity search',      description: 'Database-related query' },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const useOpenAI = process.argv.includes('--openai');
  const useOllama = process.argv.includes('--ollama');
  const DIMENSIONS = 64;

  banner();

  // ── Step 1: Initialize ──────────────────────────────────────────────────────

  step(1, 'Initialize Trovec Instance');

  let embedder: Embedder;
  let embedderName: string;

  if (useOpenAI) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      warn('OPENAI_API_KEY not set. Falling back to local embedder.');
      embedder = createLocalEmbedder({ dimensions: DIMENSIONS, warn: false });
      embedderName = 'Local (trigram hash)';
    } else {
      embedder = createOpenAIEmbedder({ apiKey, model: 'text-embedding-3-small' });
      embedderName = 'OpenAI (text-embedding-3-small)';
    }
  } else if (useOllama) {
    embedder = createOllamaEmbedder({ model: 'nomic-embed-text' });
    embedderName = 'Ollama (nomic-embed-text)';
  } else {
    embedder = createLocalEmbedder({ dimensions: DIMENSIONS, warn: false });
    embedderName = 'Local (trigram hash)';
  }

  const dimensions = embedderName.startsWith('OpenAI') ? 1536
    : embedderName.startsWith('Ollama') ? 768
    : DIMENSIONS;
  const driver = createMemoryDriver();

  const db = create({
    dimensions,
    quantization: 'F32',
    metric: 'cosine',
    embedder,
    storageDriver: driver,
  });

  info('Embedder', embedderName);
  info('Dimensions', String(dimensions));
  info('Quantization', db.config.quantization);
  info('Metric', db.config.metric);
  info('Storage', 'MemoryDriver');
  success('Instance created');

  // ── Step 2: Embed & Store Documents ─────────────────────────────────────────

  step(2, 'Embed & Store Documents');

  info('Documents', `${DOCUMENTS.length} entries to embed and store`);
  console.log();

  for (const doc of DOCUMENTS) {
    const startTime = performance.now();
    await db.addWithText(doc);
    const elapsed = (performance.now() - startTime).toFixed(1);

    const entry = db.get(doc.id)!;
    const preview = embeddingPreview(entry.embedding);
    bullet(
      `${c.cyan}${doc.id}${c.reset} ${c.dim}(${elapsed}ms)${c.reset}\n` +
      `${INDENT}     ${c.dim}"${doc.text}"${c.reset}\n` +
      `${INDENT}     ${c.dim}→${c.reset} ${preview}`
    );
  }

  console.log();
  const s = db.stats();
  success(`Stored ${c.bold}${s.entryCount}${c.reset}${c.green} entries${c.reset}`);

  // ── Step 3: Persist to Memory Storage ────────────────────────────────────────

  step(3, 'Persist to Memory Storage');

  await db.flush();
  const buffer = await driver.read(db.collectionId);
  info('Collection ID', db.collectionId);
  info('Buffer size', buffer ? `${buffer.length} bytes` : 'N/A');
  success('Flushed to MemoryDriver');

  // ── Step 4: Persist to File Storage (with Brotli compression) ──────────────

  step(4, 'Persist to File Storage (Brotli Compression)');

  const fileDriver = createFileDriver({ directory: '.trovec-demo' });
  const dbFile = create({
    dimensions,
    quantization: 'F32',
    metric: 'cosine',
    embedder,
    storageDriver: fileDriver,
  });

  // Copy entries from original db
  for (const doc of DOCUMENTS) {
    const entry = db.get(doc.id)!;
    dbFile.add(entry);
  }

  const flushStart = performance.now();
  await dbFile.flush();
  const flushElapsed = (performance.now() - flushStart).toFixed(1);

  const rawSize = buffer ? buffer.length : 0;
  const fileStat = await stat(join(fileDriver.directory, `${dbFile.collectionId}.trovec`));
  const fileSize = fileStat.size;
  const ratio = ((1 - fileSize / rawSize) * 100).toFixed(1);

  info('Directory', fileDriver.directory);
  info('Compression', 'Brotli (quality 1)');
  info('Raw size', `${rawSize} bytes`);
  info('File size', `${fileSize} bytes (${ratio}% smaller)`);
  info('Flush time', `${flushElapsed}ms`);
  success(`Persisted to file system`);

  // ── Step 5: Restore from File Storage ──────────────────────────────────────

  step(5, 'Restore from File Storage');

  const db2 = create({
    dimensions,
    quantization: 'F32',
    metric: 'cosine',
    embedder,
    storageDriver: fileDriver,
  });

  const restoreStart = performance.now();
  const fileBuffer = await fileDriver.read(dbFile.collectionId);
  if (fileBuffer) {
    db2.deserialize(fileBuffer);
  }
  const restoreElapsed = (performance.now() - restoreStart).toFixed(1);

  const s2 = db2.stats();
  info('Restored entries', String(s2.entryCount));
  info('Restore time', `${restoreElapsed}ms`);
  success(`Loaded from file${c.dim} (decompressed + deserialized, fresh instance)${c.reset}`);

  // ── Step 6: Similarity Search ───────────────────────────────────────────────

  step(6, 'Similarity Search');

  for (const q of QUERIES) {
    console.log();
    console.log(`${INDENT}  ${c.magenta}${c.bold}Query:${c.reset} "${q.text}" ${c.dim}(${q.description})${c.reset}`);

    const startTime = performance.now();
    const results = await db2.queryByText({ text: q.text, topK: 3 });
    const elapsed = (performance.now() - startTime).toFixed(1);

    console.log(`${INDENT}  ${c.dim}Results (top 3, ${elapsed}ms):${c.reset}`);

    for (let i = 0; i < results.length; i++) {
      resultRow(i + 1, String(results[i].id), results[i].score, results[i].context);
    }
  }

  // ── Step 7: Filtered Query ──────────────────────────────────────────────────

  step(7, 'Filtered Query');

  console.log(`${INDENT}  ${c.magenta}${c.bold}Query:${c.reset} "curious creatures" ${c.dim}(filter: category = animals)${c.reset}`);

  const filtered = await db2.queryByText({
    text: 'curious creatures',
    topK: 5,
    filter: (ctx) => ctx?.category === 'animals',
  });

  console.log(`${INDENT}  ${c.dim}Results (animals only):${c.reset}`);
  for (let i = 0; i < filtered.length; i++) {
    resultRow(i + 1, String(filtered[i].id), filtered[i].score, filtered[i].context);
  }

  // ── Step 8: Stats & Summary ─────────────────────────────────────────────────

  step(8, 'Final Stats');

  const finalStats = db2.stats();
  info('Total entries', String(finalStats.entryCount));
  info('Dimensions', String(finalStats.dimensions));
  info('Quantization', finalStats.quantization);
  info('Metric', finalStats.metric);
  info('Index', finalStats.indexStatus);

  // ── Cleanup ──────────────────────────────────────────────────────────────────

  step(9, 'Cleanup');

  await fileDriver.destroy();
  info('Removed', fileDriver.directory);
  success('File storage cleaned up');

  // ── Done ────────────────────────────────────────────────────────────────────

  console.log();
  console.log(`${INDENT}${c.bgGreen}${c.bold} DONE ${c.reset} ${c.green}Demo completed successfully.${c.reset}`);

  if (!useOpenAI && !useOllama) {
    console.log(`${INDENT}${c.dim}Tip: Run with --openai flag and set OPENAI_API_KEY for real embeddings.${c.reset}`);
    console.log(`${INDENT}${c.dim}Tip: Run with --ollama flag for local Ollama embeddings (requires running Ollama server).${c.reset}`);
  }

  console.log();
}

main().catch((err) => {
  console.error(`\n${c.red}Error: ${err.message}${c.reset}`);
  process.exit(1);
});
