import {
  create,
  createMemoryDriver,
  createFileDriver,
  createConcurrentFileDriver,
  withEncryption,
} from '@trovec/core';
import type { Embedder, StorageDriver } from '@trovec/core';
import { randomBytes } from 'node:crypto';
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { execFile } from 'node:child_process';
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

// ─── Prompt Helpers ───────────────────────────────────────────────────────────

async function askChoice(
  rl: ReturnType<typeof createInterface>,
  label: string,
  options: string[],
  defaultIndex: number,
): Promise<number> {
  console.log();
  console.log(`${INDENT}${c.bold}${label}${c.reset}`);
  for (let i = 0; i < options.length; i++) {
    const marker = i === defaultIndex ? ` ${c.dim}(default)${c.reset}` : '';
    console.log(`${INDENT}  ${c.cyan}[${i + 1}]${c.reset} ${options[i]}${marker}`);
  }

  const answer = await rl.question(`${INDENT}  ${c.gray}> ${c.reset}`);
  const trimmed = answer.trim();

  if (trimmed === '') return defaultIndex;

  const num = parseInt(trimmed, 10);
  if (num >= 1 && num <= options.length) return num - 1;

  warn(`Invalid choice "${trimmed}", using default.`);
  return defaultIndex;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEMO_DIR = '.trovec';
const COLLECTION_ID = 'demo';
const DIMENSIONS_LOCAL = 64;
const DIMENSIONS_OPENAI = 1536;
const DIMENSIONS_OLLAMA = 768;

const ENV_FILE = join(DEMO_DIR, '.env');

async function loadEnvValue(key: string): Promise<string | undefined> {
  try {
    const content = await readFile(ENV_FILE, 'utf-8');
    const match = content.match(new RegExp(`^${key}=(.+)$`, 'm'));
    return match?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function saveEnvValue(key: string, value: string): Promise<void> {
  await mkdir(DEMO_DIR, { recursive: true });
  let content = '';
  try {
    content = await readFile(ENV_FILE, 'utf-8');
  } catch {
    // file doesn't exist yet
  }
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + (content.length > 0 ? '\n' : '') + `${key}=${value}\n`;
  }
  await writeFile(ENV_FILE, content, 'utf-8');
}

async function askMaskedInput(
  rl: ReturnType<typeof createInterface>,
  label: string,
): Promise<string> {
  // Mask input by intercepting keystrokes
  const maskHandler = (_: string, key: { name?: string }) => {
    if (key?.name !== 'return' && key?.name !== 'enter') {
      stdout.write('\x1b[2K\x1b[G' + `${INDENT}  ${c.gray}> ${c.reset}` + '*'.repeat((rl as any).line?.length ?? 0));
    }
  };
  stdin.on('keypress', maskHandler);
  const answer = await rl.question(`${INDENT}  ${c.gray}> ${c.reset}`);
  stdin.removeListener('keypress', maskHandler);
  return answer.trim();
}

async function resolveOpenAIKey(rl: ReturnType<typeof createInterface>): Promise<string> {
  // Check .trovec/.env first, then process.env
  const envKey = await loadEnvValue('OPENAI_API_KEY');
  if (envKey) {
    bullet(`API key loaded from ${ENV_FILE}`);
    return envKey;
  }

  if (process.env.OPENAI_API_KEY) {
    bullet('API key loaded from environment');
    return process.env.OPENAI_API_KEY;
  }

  // Prompt user
  console.log();
  console.log(`${INDENT}  ${c.yellow}OPENAI_API_KEY not found.${c.reset}`);
  console.log(`${INDENT}  Enter your OpenAI API key (will be saved to ${c.dim}${ENV_FILE}${c.reset}):`);
  const apiKey = await askMaskedInput(rl, 'API key');

  if (!apiKey) {
    throw new Error('OpenAI API key is required.');
  }

  await saveEnvValue('OPENAI_API_KEY', apiKey);
  success(`API key saved to ${ENV_FILE}`);
  return apiKey;
}

async function resolveEmbedder(
  choice: number,
  rl: ReturnType<typeof createInterface>,
  dimensions?: number,
): Promise<{ embedder: Embedder; name: string }> {
  if (choice === 1) {
    const apiKey = await resolveOpenAIKey(rl);
    return {
      embedder: createOpenAIEmbedder({ apiKey, model: 'text-embedding-3-small' }),
      name: 'OpenAI (text-embedding-3-small)',
    };
  }

  if (choice === 2) {
    return {
      embedder: createOllamaEmbedder({ model: 'nomic-embed-text' }),
      name: 'Ollama (nomic-embed-text)',
    };
  }

  return {
    embedder: createLocalEmbedder({ dimensions: dimensions ?? DIMENSIONS_LOCAL, warn: false }),
    name: 'Local (trigram hash)',
  };
}

function detectEmbedderFromDimensions(dims: number): { choice: number; label: string } {
  if (dims === DIMENSIONS_OPENAI) return { choice: 1, label: 'OpenAI' };
  if (dims === DIMENSIONS_OLLAMA) return { choice: 2, label: 'Ollama' };
  return { choice: 0, label: 'Local' };
}

// ─── Demo Data ────────────────────────────────────────────────────────────────

const QUERIES = [
  { text: 'pets and animals',       description: 'Broad animal query' },
  { text: 'JavaScript programming', description: 'Programming topic' },
  { text: 'similarity search',      description: 'Database-related query' },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  banner();

  console.log(`${INDENT}${c.dim}This demo walks through Trovec's core features: embedding documents,${c.reset}`);
  console.log(`${INDENT}${c.dim}persisting data, and running similarity searches. Choose your options below.${c.reset}`);

  const rl = createInterface({ input: stdin, output: stdout });

  // ── Prompt: Storage ─────────────────────────────────────────────────────────

  const storageChoice = await askChoice(rl, 'Storage:', ['In-memory', 'Persisted (file)'], 0);
  const usePersisted = storageChoice === 1;

  // ── Prompt: Storage mode (standard vs concurrent) ──────────────────────────

  let useConcurrent = false;
  if (usePersisted) {
    const modeChoice = await askChoice(rl, 'Storage mode:', ['Standard', 'Concurrent (file locking + WAL)'], 0);
    useConcurrent = modeChoice === 1;
  }

  // ── Prompt: Encryption ──────────────────────────────────────────────────────

  let useEncryption = false;
  let encryptionKey: Buffer | undefined;
  if (usePersisted) {
    const encChoice = await askChoice(rl, 'Encryption at rest:', ['No encryption', 'AES-256-GCM'], 0);
    useEncryption = encChoice === 1;
    if (useEncryption) {
      const savedHex = await loadEnvValue('TROVEC_ENCRYPTION_KEY');
      if (savedHex && savedHex.length === 64) {
        encryptionKey = Buffer.from(savedHex, 'hex');
        bullet(`Encryption key loaded from ${ENV_FILE}`);
      } else {
        encryptionKey = randomBytes(32);
        await saveEnvValue('TROVEC_ENCRYPTION_KEY', encryptionKey.toString('hex'));
        success(`New encryption key generated and saved to ${ENV_FILE}`);
      }
    }
  }

  // ── Prompt: Reuse or start fresh (if persisted + data exists) ────────────────

  let reuseData = false;
  let fileDriver: (ReturnType<typeof createFileDriver> | ReturnType<typeof createConcurrentFileDriver>) | null = null;
  let storageDriverForTrovec: StorageDriver | null = null;

  if (usePersisted) {
    if (useConcurrent) {
      const concurrentDriver = createConcurrentFileDriver({
        directory: DEMO_DIR,
        wal: true,
      });
      fileDriver = concurrentDriver;
      storageDriverForTrovec = useEncryption && encryptionKey
        ? withEncryption(concurrentDriver, { key: encryptionKey })
        : concurrentDriver;
    } else {
      const basicDriver = createFileDriver({ directory: DEMO_DIR });
      fileDriver = basicDriver;
      storageDriverForTrovec = useEncryption && encryptionKey
        ? withEncryption(basicDriver, { key: encryptionKey })
        : basicDriver;
    }
  }

  let embedder: Embedder;
  let embedderName: string;

  // Check for existing data — use the decryption-capable driver to read dimensions
  const readDriver = storageDriverForTrovec ?? fileDriver;
  if (fileDriver && readDriver && await fileDriver.exists(COLLECTION_ID)) {
    let canReuse = true;
    let storedDims = 0;

    try {
      const existingBuffer = await readDriver.read(COLLECTION_ID);
      storedDims = existingBuffer!.readUInt32LE(5);
    } catch {
      // Can't read existing data (e.g. encrypted with a different key) — start fresh
      canReuse = false;
    }

    if (canReuse && storedDims > 0) {
      const detected = detectEmbedderFromDimensions(storedDims);
      const detectedLabel = detected.label;
      const encLabel = useEncryption ? ', encrypted' : '';

      const reuseChoice = await askChoice(
        rl,
        `Existing data found (embedder: ${detectedLabel}, ${storedDims} dims${encLabel}):`,
        ['Continue with existing data', 'Start fresh'],
        0,
      );

      if (reuseChoice === 0) {
        reuseData = true;
        const detectedResolved = await resolveEmbedder(detected.choice, rl, storedDims);
        embedder = detectedResolved.embedder;
        embedderName = detectedResolved.name;
      } else {
        await fileDriver.delete(COLLECTION_ID);
        const embedderChoice = await askChoice(rl, 'Embedder:', ['Local (no setup needed)', 'OpenAI (requires API key)', 'Ollama (requires running server)'], 0);
        const resolved = await resolveEmbedder(embedderChoice, rl);
        embedder = resolved.embedder;
        embedderName = resolved.name;
      }
    } else {
      // Existing file is unreadable — delete and start fresh
      await fileDriver.delete(COLLECTION_ID);
      const embedderChoice = await askChoice(rl, 'Embedder:', ['Local (no setup needed)', 'OpenAI (requires API key)', 'Ollama (requires running server)'], 0);
      const resolved = await resolveEmbedder(embedderChoice, rl);
      embedder = resolved.embedder;
      embedderName = resolved.name;
    }
  } else {
    const embedderChoice = await askChoice(rl, 'Embedder:', ['Local (no setup needed)', 'OpenAI (requires API key)', 'Ollama (requires running server)'], 0);
    const resolved = await resolveEmbedder(embedderChoice, rl);
    embedder = resolved.embedder;
    embedderName = resolved.name;
  }

  rl.close();

  // ── Step counter ────────────────────────────────────────────────────────────

  let stepNum = 0;
  const nextStep = (title: string) => step(++stepNum, title);

  // ── Step: Initialize ────────────────────────────────────────────────────────

  nextStep('Initialize Trovec Instance');

  const storageDriver = storageDriverForTrovec ?? createMemoryDriver();
  const createStart = performance.now();
  let db = await create({
    quantization: 'F32',
    metric: 'cosine',
    embedder,
    storageDriver,
    collectionId: COLLECTION_ID,
  });
  const createElapsed = (performance.now() - createStart).toFixed(1);

  info('Embedder', embedderName);
  info('Dimensions', String(db.config.dimensions));
  info('Quantization', db.config.quantization);
  info('Metric', db.config.metric);

  let storageLabel: string;
  if (!fileDriver) {
    storageLabel = 'MemoryDriver';
  } else if (useConcurrent) {
    storageLabel = `ConcurrentFileDriver + WAL (${DEMO_DIR}/)`;
  } else {
    storageLabel = `FileDriver (${DEMO_DIR}/)`;
  }
  info('Storage', storageLabel);

  if (useEncryption) {
    info('Encryption', `${c.green}AES-256-GCM${c.reset} ${c.dim}(256-bit key, per-file IV)${c.reset}`);
    if (useConcurrent) {
      info('WAL encryption', `${c.green}Enabled${c.reset} ${c.dim}(per-entry encryption)${c.reset}`);
    }
  }
  info('Collection ID', db.collectionId);
  success(`Instance created${c.dim} (${createElapsed}ms)${c.reset}`);

  // ── Step: Restore or Embed ──────────────────────────────────────────────────

  if (reuseData) {
    // Path C: Data auto-loaded by create()
    nextStep('Data Restored from Storage');

    const s = db.stats();
    info('Restored entries', String(s.entryCount));
    success(`Loaded automatically${c.dim} (decompressed + deserialized during create)${c.reset}`);
  } else {
    // Path A/B: Embed fresh documents
    nextStep('Embed & Store Documents');

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
    success(`Stored ${c.bold}${s.entryCount}${c.reset}${c.green} entries ${c.dim}(auto-flush will persist automatically)${c.reset}`);
  }

  // ── Step: Concurrent Access Test (only in concurrent mode) ──────────────────

  if (useConcurrent && !reuseData) {
    nextStep('Concurrent Access Test');

    const WORKER_COUNT = 3;
    const ENTRIES_PER_WORKER = 5;
    const workerScript = new URL('./concurrent-worker.ts', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');

    info('Workers', `${WORKER_COUNT} parallel processes, ${ENTRIES_PER_WORKER} entries each`);
    info('Target', `Same collection file (${DEMO_DIR}/${COLLECTION_ID}.trovec)`);
    console.log();

    bullet('Flushing current data to disk before spawning workers...');
    await db.flush();

    const entriesBefore = db.stats().entryCount;

    // Spawn workers in parallel
    bullet(`Spawning ${WORKER_COUNT} worker processes...`);
    console.log();

    const workerPromises = Array.from({ length: WORKER_COUNT }, (_, i) => {
      return new Promise<{ workerIndex: number; entryCount: number; elapsed: string }>((res, rej) => {
        const workerArgs = [
          'tsx', workerScript,
          resolve(DEMO_DIR), COLLECTION_ID,
          String(i + 1),
          String(db.config.dimensions),
          String(ENTRIES_PER_WORKER),
        ];
        if (encryptionKey) {
          workerArgs.push(encryptionKey.toString('hex'));
        }
        execFile('npx', workerArgs, { timeout: 60_000, shell: true }, (err, stdoutData, stderrData) => {
          if (err) {
            rej(new Error(`Worker ${i + 1} failed: ${stderrData || err.message}`));
            return;
          }
          try {
            // Find the last line that looks like JSON (worker output)
            const lines = stdoutData.trim().split('\n');
            const jsonLine = lines.reverse().find(l => l.startsWith('{'));
            res(JSON.parse(jsonLine!));
          } catch {
            rej(new Error(`Worker ${i + 1} invalid output: ${stdoutData}`));
          }
        });
      });
    });

    const results = await Promise.all(workerPromises);

    for (const r of results) {
      success(`Worker ${c.cyan}#${r.workerIndex}${c.reset}${c.green} wrote ${c.bold}${r.entryCount}${c.reset}${c.green} entries ${c.dim}(${r.elapsed}ms)${c.reset}`);
    }

    // Reopen the collection to see merged data from all workers
    console.log();
    bullet('Reopening collection to verify merged data...');

    // Re-create the instance to pick up WAL entries from all workers
    await db.close();
    const dbReopened = await create({
      quantization: 'F32',
      metric: 'cosine',
      embedder,
      storageDriver: storageDriverForTrovec ?? createMemoryDriver(),
      collectionId: COLLECTION_ID,
    });

    const entriesAfter = dbReopened.stats().entryCount;
    const entriesAdded = entriesAfter - entriesBefore;
    const expectedAdded = WORKER_COUNT * ENTRIES_PER_WORKER;

    console.log();
    info('Entries before', String(entriesBefore));
    info('Entries after', String(entriesAfter));
    info('Added by workers', `${entriesAdded} ${c.dim}(expected: ${expectedAdded})${c.reset}`);

    if (entriesAdded === expectedAdded) {
      success(`${c.bold}All ${expectedAdded} entries from ${WORKER_COUNT} processes persisted — no data lost!${c.reset}`);
    } else {
      warn(`Expected ${expectedAdded} new entries but found ${entriesAdded}. Some writes may have been lost.`);
    }

    // Replace db with reopened instance for the rest of the demo
    db = dbReopened;
  }

  // ── Step: Similarity Search ─────────────────────────────────────────────────

  nextStep('Similarity Search');

  for (const q of QUERIES) {
    console.log();
    console.log(`${INDENT}  ${c.magenta}${c.bold}Query:${c.reset} "${q.text}" ${c.dim}(${q.description})${c.reset}`);

    const startTime = performance.now();
    const results = await db.queryByText({ text: q.text, topK: 3 });
    const elapsed = (performance.now() - startTime).toFixed(1);

    console.log(`${INDENT}  ${c.dim}Results (top 3, ${elapsed}ms):${c.reset}`);

    for (let i = 0; i < results.length; i++) {
      resultRow(i + 1, String(results[i].id), results[i].score, results[i].context);
    }
  }

  // ── Step: Filtered Query ────────────────────────────────────────────────────

  nextStep('Filtered Query');

  console.log(`${INDENT}  ${c.magenta}${c.bold}Query:${c.reset} "curious creatures" ${c.dim}(filter: category = animals)${c.reset}`);

  const filtered = await db.queryByText({
    text: 'curious creatures',
    topK: 5,
    filter: (ctx) => ctx?.category === 'animals',
  });

  console.log(`${INDENT}  ${c.dim}Results (animals only):${c.reset}`);
  for (let i = 0; i < filtered.length; i++) {
    resultRow(i + 1, String(filtered[i].id), filtered[i].score, filtered[i].context);
  }

  // ── Step: Close (flush + cleanup) ────────────────────────────────────────────

  nextStep('Close Instance');

  const closeStart = performance.now();
  await db.close();
  const closeElapsed = (performance.now() - closeStart).toFixed(1);

  success(`Instance closed ${c.dim}(final flush + cleanup in ${closeElapsed}ms)${c.reset}`);

  if (useConcurrent) {
    info('Mode', 'Concurrent (file locking + WAL)');
    bullet(`WAL entries were appended incrementally during mutations`);
  }

  if (fileDriver) {
    const memDriver = createMemoryDriver();
    const dbTemp = await create({ dimensions: db.config.dimensions, quantization: 'F32', metric: 'cosine', storageDriver: memDriver, autoFlush: false });
    for (const doc of DOCUMENTS) {
      const entry = db.get(doc.id);
      if (entry) dbTemp.add(entry);
    }
    await dbTemp.flush();
    const rawBuffer = await memDriver.read(dbTemp.collectionId);
    const rawSize = rawBuffer ? rawBuffer.length : 0;

    const fileStat = await stat(join(fileDriver.directory, `${db.collectionId}.trovec`));
    const fileSize = fileStat.size;
    const ratio = rawSize > 0 ? ((1 - fileSize / rawSize) * 100).toFixed(1) : '0';

    info('Compression', 'Brotli (quality 1)');
    info('Raw size', `${rawSize} bytes`);
    info('File size', `${fileSize} bytes (${ratio}% smaller)`);

    if (useEncryption) {
      console.log();
      info('Encryption', `${c.green}AES-256-GCM${c.reset}`);
      info('Encryption overhead', `110 bytes ${c.dim}(v2 envelope header: KEK metadata + encrypted DEK + data IV + auth tag)${c.reset}`);

      // Show that file is opaque
      const rawFileBytes = await readFile(join(fileDriver.directory, `${db.collectionId}.trovec`));
      const containsMagic = rawFileBytes.includes(Buffer.from('VCR\x01'));
      if (!containsMagic) {
        success(`File on disk is fully encrypted — no plaintext headers or data detected`);
      }

      // Show encrypted vs unencrypted file size comparison
      const unencryptedDriver = useConcurrent
        ? createConcurrentFileDriver({ directory: join(DEMO_DIR, '__enc_compare__'), wal: false })
        : createFileDriver({ directory: join(DEMO_DIR, '__enc_compare__') });
      const dbCompare = await create({
        dimensions: db.config.dimensions, quantization: 'F32', metric: 'cosine',
        storageDriver: unencryptedDriver, collectionId: 'cmp', autoFlush: false,
      });
      for (const doc of DOCUMENTS) {
        const entry = db.get(doc.id);
        if (entry) dbCompare.add(entry);
      }
      await dbCompare.flush();
      const unencStat = await stat(join(unencryptedDriver.directory, 'cmp.trovec'));
      const overhead = fileSize - unencStat.size;
      const overheadPct = unencStat.size > 0 ? ((overhead / unencStat.size) * 100).toFixed(2) : '0';
      info('Unencrypted file', `${unencStat.size} bytes`);
      info('Encrypted file', `${fileSize} bytes ${c.dim}(+${overhead} bytes / +${overheadPct}% overhead)${c.reset}`);
      await unencryptedDriver.destroy();
    }
  }

  // ── Step: Final Stats ───────────────────────────────────────────────────────

  nextStep('Final Stats');

  const finalStats = db.stats();
  info('Total entries', String(finalStats.entryCount));
  info('Dimensions', String(finalStats.dimensions));
  info('Quantization', finalStats.quantization);
  info('Metric', finalStats.metric);
  info('Index', finalStats.indexStatus);
  info('Encryption', useEncryption ? `${c.green}AES-256-GCM (enabled)${c.reset}` : `${c.dim}None${c.reset}`);

  // ── Done ────────────────────────────────────────────────────────────────────

  console.log();
  console.log(`${INDENT}${c.bgGreen}${c.bold} DONE ${c.reset} ${c.green}Demo completed successfully.${c.reset}`);

  if (fileDriver) {
    console.log(`${INDENT}${c.dim}Data saved to ${DEMO_DIR}/. Run again to reuse or start clean.${c.reset}`);
  }

  console.log();
}

main().catch((err) => {
  console.error(`\n${c.red}Error: ${err.message}${c.reset}`);
  process.exit(1);
});
