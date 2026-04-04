/**
 * Concurrent worker — spawned as a child process by the demo.
 *
 * Usage: tsx demo/src/concurrent-worker.ts <directory> <collectionId> <workerIndex> <dimensions> <entryCount> [encryptionKeyHex]
 *
 * Each worker opens the same collection via ConcurrentFileDriver (WAL mode),
 * adds a batch of entries with a worker-specific ID prefix, flushes, and closes.
 * Prints a JSON result to stdout when done.
 */
import { create, createConcurrentFileDriver } from '@trovec/core';
import { createLocalEmbedder } from '@trovec/embedder-local';

const [directory, collectionId, workerIndexStr, dimensionsStr, entryCountStr, encryptionKeyHex] = process.argv.slice(2);
const workerIndex = parseInt(workerIndexStr, 10);
const dimensions = parseInt(dimensionsStr, 10);
const entryCount = parseInt(entryCountStr, 10);

async function run() {
  const driver = createConcurrentFileDriver({
    directory,
    wal: true,
    ...(encryptionKeyHex ? { encryption: { key: Buffer.from(encryptionKeyHex, 'hex') } } : {}),
  });
  const embedder = createLocalEmbedder({ dimensions, warn: false });

  const db = await create({
    quantization: 'F32',
    metric: 'cosine',
    embedder,
    storageDriver: driver,
    collectionId,
  });

  const startTime = performance.now();

  for (let i = 0; i < entryCount; i++) {
    const id = `w${workerIndex}-entry-${String(i + 1).padStart(2, '0')}`;
    const text = `Worker ${workerIndex} concurrent test entry number ${i + 1}`;
    await db.addWithText({ id, text, context: { worker: workerIndex, index: i + 1 } });
  }

  await db.flush();
  await db.close();

  const elapsed = (performance.now() - startTime).toFixed(1);

  // Report results to parent via stdout
  console.log(JSON.stringify({ workerIndex, entryCount, elapsed }));
}

run().catch((err) => {
  console.error(JSON.stringify({ workerIndex, error: err.message }));
  process.exit(1);
});
