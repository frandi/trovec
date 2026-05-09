#!/usr/bin/env node
// Idempotent model fetcher for @trovec/embedder-edge.
//
// Downloads bundled model assets from a pinned HuggingFace revision and
// verifies SHA256 checksums against `manifest.json`. Files are skipped if
// already present and verified. No external dependencies — uses Node 18+
// built-in fetch and node:crypto.
//
// Usage:
//   node scripts/fetch-models.mjs            verify-or-fetch (default)
//   node scripts/fetch-models.mjs --record   download and write SHAs into manifest.json
//                                            (bootstrap only; commit the result)

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const MODELS_DIR = join(ROOT, 'models');

const MODELS = ['bge-small-en-v1.5'];

const recordMode = process.argv.includes('--record');

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256Of(path) {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

async function download(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  const chunks = [];
  let received = 0;
  let lastReport = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    received += chunk.length;
    const now = Date.now();
    if (total && now - lastReport > 500) {
      const pct = ((received / total) * 100).toFixed(1);
      const mb = (received / 1024 / 1024).toFixed(1);
      const totalMb = (total / 1024 / 1024).toFixed(1);
      process.stderr.write(`\r  ${mb}/${totalMb} MB (${pct}%)`);
      lastReport = now;
    }
  }
  if (total) process.stderr.write('\n');
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, Buffer.concat(chunks));
}

async function processFile(modelDir, revision, baseUrl, file, recorded) {
  const localPath = join(modelDir, file.path);
  const url = `${baseUrl}/resolve/${revision}/${file.path}`;

  // If file exists, see if we can skip.
  if (await fileExists(localPath)) {
    const localSha = await sha256Of(localPath);
    if (recorded && localSha === recorded) {
      console.log(`  ✓ ${file.path} (cached, sha256 matches)`);
      return { sha256: localSha, downloaded: false };
    }
    if (recorded && localSha !== recorded) {
      throw new Error(
        `  ✗ ${file.path}: local SHA256 ${localSha} does not match recorded ${recorded}.\n` +
        `    Delete the file and re-run, or pass --record to update the manifest.`,
      );
    }
    if (!recorded) {
      console.log(`  ! ${file.path} (cached, no recorded SHA — computed ${localSha})`);
      return { sha256: localSha, downloaded: false };
    }
  }

  // Download fresh.
  console.log(`  ↓ ${file.path}`);
  await download(url, localPath);
  const sha256 = await sha256Of(localPath);
  if (recorded && sha256 !== recorded) {
    throw new Error(
      `  ✗ ${file.path}: downloaded SHA256 ${sha256} does not match recorded ${recorded}.\n` +
      `    Aborting — file integrity check failed.`,
    );
  }
  console.log(`  ✓ ${file.path} (sha256: ${sha256.slice(0, 16)}…)`);
  return { sha256, downloaded: true };
}

async function processModel(modelId) {
  const modelDir = join(MODELS_DIR, modelId);
  const manifestPath = join(modelDir, 'manifest.json');

  const manifestRaw = await readFile(manifestPath, 'utf-8').catch(() => {
    throw new Error(`Missing manifest at ${manifestPath}`);
  });
  const manifest = JSON.parse(manifestRaw);
  const baseUrl = `https://huggingface.co/${manifest.repo}`;

  console.log(`\nModel: ${modelId} @ ${manifest.revision}`);

  const updated = { ...manifest, files: [] };
  let anyChanged = false;
  for (const file of manifest.files) {
    const result = await processFile(modelDir, manifest.revision, baseUrl, file, file.sha256);
    if (recordMode && result.sha256 !== file.sha256) {
      updated.files.push({ path: file.path, sha256: result.sha256 });
      anyChanged = true;
    } else {
      updated.files.push(file);
    }
  }

  if (recordMode && anyChanged) {
    await writeFile(manifestPath, JSON.stringify(updated, null, 2) + '\n');
    console.log(`  · manifest.json updated with new SHAs.`);
  }
}

async function main() {
  if (recordMode) {
    console.log('--record mode: will write computed SHAs into manifest.json.');
  }
  for (const modelId of MODELS) {
    await processModel(modelId);
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('\nfetch-models failed:');
  console.error(err.message);
  process.exit(1);
});
