// Idempotent downloader for the benchmark-only ONNX models. Mirrors the
// pattern used by packages/embedder-edge/scripts/fetch-models.mjs: download
// from a pinned HuggingFace revision, verify SHA256 checksums against
// bench/checksums.json, write computed SHAs back when running with
// BENCH_RECORD_CHECKSUMS=1 (bootstrap only — commit the result).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchModelSpec } from './models.js';

const __filename = fileURLToPath(import.meta.url);
const POC_ROOT = resolve(dirname(__filename), '..', '..');
const BENCH_MODELS_DIR = join(POC_ROOT, 'bench-models');
const CHECKSUMS_PATH = join(POC_ROOT, 'src', 'bench', 'checksums.json');

const RECORD_MODE = process.env.BENCH_RECORD_CHECKSUMS === '1';

interface ChecksumsFile {
  /** Keyed by `${repo}@${revision}/${path}`. */
  [key: string]: string;
}

function loadChecksums(): ChecksumsFile {
  if (!existsSync(CHECKSUMS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CHECKSUMS_PATH, 'utf-8')) as ChecksumsFile;
  } catch {
    return {};
  }
}

function saveChecksums(data: ChecksumsFile): void {
  // Sort keys for deterministic diffs.
  const sorted: ChecksumsFile = {};
  for (const k of Object.keys(data).sort()) sorted[k] = data[k];
  writeFileSync(CHECKSUMS_PATH, JSON.stringify(sorted, null, 2) + '\n');
}

function checksumKey(spec: BenchModelSpec, filePath: string): string {
  return `${spec.hfRepo}@${spec.hfRevision}/${filePath}`;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function sha256Of(p: string): Promise<string> {
  const buf = await readFile(p);
  return createHash('sha256').update(buf).digest('hex');
}

async function downloadTo(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const chunks: Buffer[] = [];
  let received = 0;
  let lastReport = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    received += chunk.length;
    const now = Date.now();
    if (total && now - lastReport > 750) {
      const pct = ((received / total) * 100).toFixed(1);
      const mb = (received / 1024 / 1024).toFixed(1);
      const totalMb = (total / 1024 / 1024).toFixed(1);
      process.stderr.write(`\r    ${mb}/${totalMb} MB (${pct}%)`);
      lastReport = now;
    }
  }
  if (total) process.stderr.write('\n');
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, Buffer.concat(chunks));
}

/** Returns the on-disk directory holding this model's files. */
export function modelDir(spec: BenchModelSpec): string {
  return join(BENCH_MODELS_DIR, spec.id);
}

export async function ensureModelDownloaded(spec: BenchModelSpec): Promise<void> {
  const dir = modelDir(spec);
  const baseUrl = `https://huggingface.co/${spec.hfRepo}/resolve/${spec.hfRevision}`;
  const checksums = loadChecksums();
  let dirty = false;

  console.error(`[fetch] ${spec.id} (${spec.hfRepo}@${spec.hfRevision.slice(0, 7)})`);

  for (const filePath of spec.hfFiles) {
    const localPath = join(dir, filePath);
    const key = checksumKey(spec, filePath);
    const recorded = checksums[key];

    if (await fileExists(localPath)) {
      const localSha = await sha256Of(localPath);
      if (recorded && localSha === recorded) {
        console.error(`  ✓ ${filePath} (cached)`);
        continue;
      }
      if (recorded && localSha !== recorded) {
        if (!RECORD_MODE) {
          throw new Error(
            `SHA256 mismatch for ${spec.id}/${filePath}: ` +
            `local ${localSha} != recorded ${recorded}. ` +
            `Delete bench-models/${spec.id} and re-run, or set BENCH_RECORD_CHECKSUMS=1 to update.`,
          );
        }
        checksums[key] = localSha;
        dirty = true;
        console.error(`  ! ${filePath} (sha mismatch — recorded new value: ${localSha.slice(0, 16)}…)`);
        continue;
      }
      // No recorded SHA yet.
      checksums[key] = localSha;
      dirty = true;
      console.error(`  ! ${filePath} (cached, sha recorded: ${localSha.slice(0, 16)}…)`);
      continue;
    }

    // Download fresh.
    console.error(`  ↓ ${filePath}`);
    await downloadTo(`${baseUrl}/${filePath}`, localPath);
    const sha = await sha256Of(localPath);
    if (recorded && sha !== recorded && !RECORD_MODE) {
      throw new Error(
        `Downloaded ${spec.id}/${filePath} has sha256 ${sha} but expected ${recorded}.`,
      );
    }
    checksums[key] = sha;
    dirty = true;
    console.error(`  ✓ ${filePath} (sha256: ${sha.slice(0, 16)}…)`);
  }

  if (dirty) saveChecksums(checksums);
}

/** Convenience: ensure every model in the registry is downloaded. */
export async function ensureAllModelsDownloaded(specs: BenchModelSpec[]): Promise<void> {
  for (const spec of specs) {
    await ensureModelDownloaded(spec);
  }
}
