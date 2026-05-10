// Corpus auto-fetcher for the benchmark. Downloads NIST SP 800-63B
// (Digital Identity Guidelines) — a public-domain, English-only,
// substantive technical PDF — to uploads/ if it isn't there yet.
// Verifies SHA256 against a pinned value in bench/checksums.json.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const POC_ROOT = resolve(dirname(__filename), '..', '..');
const UPLOADS_DIR = join(POC_ROOT, 'uploads');
const CHECKSUMS_PATH = join(POC_ROOT, 'src', 'bench', 'checksums.json');

const RECORD_MODE = process.env.BENCH_RECORD_CHECKSUMS === '1';

export interface CorpusSource {
  name: string;
  url: string;
  fileName: string;
  description: string;
}

export const NIST_SP_800_63B: CorpusSource = {
  name: 'NIST SP 800-63B',
  url: 'https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-63b.pdf',
  fileName: 'NIST.SP.800-63b.pdf',
  description: 'Digital Identity Guidelines — Authentication and Lifecycle Management. Public domain (US government). English only.',
};

function checksumKey(source: CorpusSource): string {
  return `corpus:${source.url}`;
}

function loadChecksums(): Record<string, string> {
  if (!existsSync(CHECKSUMS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CHECKSUMS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveChecksums(data: Record<string, string>): void {
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(data).sort()) sorted[k] = data[k];
  writeFileSync(CHECKSUMS_PATH, JSON.stringify(sorted, null, 2) + '\n');
}

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
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
  for await (const chunk of res.body as unknown as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    received += chunk.length;
    if (total) {
      const pct = ((received / total) * 100).toFixed(0);
      process.stderr.write(`\r    ${pct}%`);
    }
  }
  if (total) process.stderr.write('\n');
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, Buffer.concat(chunks));
}

/** Returns the local path; downloads if missing. */
export async function ensureCorpus(source: CorpusSource = NIST_SP_800_63B): Promise<string> {
  const localPath = join(UPLOADS_DIR, source.fileName);
  const checksums = loadChecksums();
  const key = checksumKey(source);
  const recorded = checksums[key];

  console.error(`[corpus] ${source.name}`);

  if (await fileExists(localPath)) {
    const localSha = await sha256Of(localPath);
    if (recorded && localSha === recorded) {
      console.error(`  ✓ already downloaded (sha matches)`);
      return localPath;
    }
    if (recorded && !RECORD_MODE) {
      throw new Error(
        `Corpus SHA mismatch: local ${localSha} != recorded ${recorded}. ` +
        `Delete uploads/${source.fileName} and re-run, or set BENCH_RECORD_CHECKSUMS=1.`,
      );
    }
    checksums[key] = localSha;
    saveChecksums(checksums);
    console.error(`  ! recorded sha: ${localSha.slice(0, 16)}…`);
    return localPath;
  }

  console.error(`  ↓ downloading from ${source.url}`);
  await downloadTo(source.url, localPath);
  const sha = await sha256Of(localPath);
  if (recorded && sha !== recorded && !RECORD_MODE) {
    throw new Error(`Downloaded corpus has sha ${sha} but expected ${recorded}.`);
  }
  checksums[key] = sha;
  saveChecksums(checksums);
  console.error(`  ✓ saved (sha256: ${sha.slice(0, 16)}…)`);
  return localPath;
}
