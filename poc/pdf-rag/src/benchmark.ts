// Benchmark V3: compare bge-small / bge-base / bge-large / all-MiniLM-L6-v2
// (loaded via the embedder-edge low-level building blocks) against
// text-embedding-3-small (cloud) on a confirmed-English PDF corpus
// (NIST SP 800-63B, auto-fetched on first run).
//
// Compared to V2 (single-model, partly-Indonesian corpus):
//   - Auto-fetches corpus + bench-only ONNX models on first run.
//   - Iterates over BENCH_MODELS so users can read a tier matrix.
//   - Re-uses the V2 query generator and evaluation methodology.
//
// Usage:
//   OPENAI_API_KEY=... npm run benchmark
//
// Useful env:
//   SKIP_OPENAI=1                 only run the local edge models
//   BENCH_QUERIES_PER_CHUNK=N     queries per chunk (default 1)
//   BENCH_REGENERATE_QUERIES=1    force regeneration of bench-queries.json
//   BENCH_BATCH_SIZES=1,10,100    throughput batch sizes
//   BENCH_RESULTS_PATH=path.json  override BENCHMARK_RESULTS.json path
//   BENCH_QUERY_MODEL=gpt-5-nano  model used to generate queries
//   BENCH_RECORD_CHECKSUMS=1      first-time bootstrap; record SHAs for fetched files
//   BENCH_MODEL_FILTER=ids,...    comma-separated subset of model ids to run
//   BENCH_PDF=/path/to/file       skip auto-fetch and use this PDF instead

import { config } from 'dotenv';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { LiteParse } from '@llamaindex/liteparse';
import { create, createMemoryDriver } from '@trovec/core';
import type { Embedder, Trovec } from '@trovec/core';
import { createOpenAIEmbedder } from '@trovec/embedder-openai';
import { generateOrLoadQueries, type GeneratedQuery } from './bench/query-gen.js';
import { BENCH_MODELS, type BenchModelSpec } from './bench/models.js';
import { ensureModelDownloaded, modelDir } from './bench/fetch-models.js';
import { ensureCorpus } from './bench/fetch-corpus.js';
import { createBenchEmbedder } from './bench/embedder.js';

config();

const SKIP_OPENAI = process.env.SKIP_OPENAI === '1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const QUERIES_PER_CHUNK = parseInt(process.env.BENCH_QUERIES_PER_CHUNK ?? '1', 10);
const REGENERATE_QUERIES = process.env.BENCH_REGENERATE_QUERIES === '1';
const QUERY_MODEL = process.env.BENCH_QUERY_MODEL ?? 'gpt-5-nano';
const BATCH_SIZES = (process.env.BENCH_BATCH_SIZES ?? '1,10,100')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);
const MODEL_FILTER = process.env.BENCH_MODEL_FILTER
  ? new Set(process.env.BENCH_MODEL_FILTER.split(',').map((s) => s.trim()).filter(Boolean))
  : null;
const POC_ROOT = process.cwd();
const QUERIES_CACHE_PATH = join(POC_ROOT, 'bench-queries.json');
const RESULTS_PATH = process.env.BENCH_RESULTS_PATH
  ? join(POC_ROOT, process.env.BENCH_RESULTS_PATH)
  : join(POC_ROOT, 'BENCHMARK_RESULTS.json');

const MIN_CHUNK_LENGTH = 100;
const MAX_CHUNK_LENGTH = 500;

// ----- corpus loading -----

interface Chunk {
  id: string;
  text: string;
  pageNumber: number;
}

function chunkPage(pageText: string, pageNumber: number, fileName: string): Chunk[] {
  const paragraphs = pageText.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return [];
  const out: Chunk[] = [];
  let buffer = '';
  let idx = 0;
  for (const para of paragraphs) {
    if (buffer.length + para.length > MAX_CHUNK_LENGTH && buffer.length >= MIN_CHUNK_LENGTH) {
      out.push({ id: `${fileName}:p${pageNumber}:c${idx++}`, text: buffer.trim(), pageNumber });
      buffer = '';
    }
    buffer += (buffer ? '\n\n' : '') + para;
  }
  if (buffer.trim().length > 0) {
    out.push({ id: `${fileName}:p${pageNumber}:c${idx++}`, text: buffer.trim(), pageNumber });
  }
  return out;
}

async function loadCorpus(): Promise<{ fileName: string; chunks: Chunk[] }> {
  const explicit = process.env.BENCH_PDF;
  const pdfPath = explicit ?? (await ensureCorpus());
  const fileName = pdfPath.split('/').pop()!;
  const parser = new LiteParse({ ocrEnabled: false });
  const result = await parser.parse(pdfPath);
  const chunks: Chunk[] = [];
  for (const page of result.pages) {
    const trimmed = page.text.trim();
    if (trimmed.length === 0) continue;
    chunks.push(...chunkPage(trimmed, page.pageNum, fileName));
  }
  return { fileName, chunks };
}

// ----- memory snapshots -----

interface MemSnapshot { rss: number; heap: number; external: number }

function memSnapshot(): MemSnapshot {
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const m = process.memoryUsage();
  return { rss: m.rss, heap: m.heapUsed, external: m.external };
}

const toMB = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

// ----- throughput micro-bench -----

interface ThroughputPoint {
  batchSize: number;
  totalMs: number;
  perItemMs: number;
  itemsPerSec: number;
}

async function measureThroughput(
  embedder: Embedder,
  samples: string[],
  batchSizes: number[],
): Promise<ThroughputPoint[]> {
  const out: ThroughputPoint[] = [];
  for (const requested of batchSizes) {
    const N = Math.min(requested, samples.length);
    if (N === 0) continue;
    const batch = samples.slice(0, N);
    await embedder.embedMany(batch.slice(0, Math.min(2, N)));
    const start = performance.now();
    await embedder.embedMany(batch);
    const elapsed = performance.now() - start;
    out.push({ batchSize: N, totalMs: elapsed, perItemMs: elapsed / N, itemsPerSec: (N / elapsed) * 1000 });
  }
  return out;
}

// ----- ingest + per-query -----

interface IngestStats { totalMs: number; chunksPerSec: number; ingestBatchSize: number }

const INGEST_BATCH = 32;

/**
 * Ingest chunks in fixed-size batches of {@link INGEST_BATCH}. Each batch's
 * tokenizer pads only to the longest input *within the batch*, which avoids
 * the pathological case of padding 480 short chunks to a 512-token tensor
 * (some chunks are short — padding them to 512 makes a 6× difference but the
 * O(seq²) attention cost makes it more like 100× of compute waste).
 *
 * For the OpenAI embedder this is also more realistic: real applications
 * batch incrementally rather than sending the whole corpus in one HTTP call.
 */
async function ingestAll(db: Trovec, chunks: Chunk[]): Promise<IngestStats> {
  const start = performance.now();
  for (let i = 0; i < chunks.length; i += INGEST_BATCH) {
    const slice = chunks.slice(i, i + INGEST_BATCH);
    await db.addManyWithText(
      slice.map((c) => ({ id: c.id, text: c.text, context: { pageNumber: c.pageNumber } })),
    );
  }
  const elapsed = performance.now() - start;
  return { totalMs: elapsed, chunksPerSec: (chunks.length / elapsed) * 1000, ingestBatchSize: INGEST_BATCH };
}

interface PerQueryResult {
  queryId: string;
  queryText: string;
  expectedChunkId: string;
  rankOfExpected: number;
  topIds: string[];
  topScores: number[];
  latencyMs: number;
}

async function runQueries(db: Trovec, queries: GeneratedQuery[]): Promise<PerQueryResult[]> {
  const out: PerQueryResult[] = [];
  for (const q of queries) {
    if (q.text === null) continue;
    const start = performance.now();
    const results = await db.queryByText({ text: q.text, topK: 100 });
    const elapsed = performance.now() - start;
    const rank = results.findIndex((r) => String(r.id) === q.expectedChunkId);
    out.push({
      queryId: q.id,
      queryText: q.text,
      expectedChunkId: q.expectedChunkId,
      rankOfExpected: rank,
      topIds: results.slice(0, 5).map((r) => String(r.id)),
      topScores: results.slice(0, 5).map((r) => Number(r.score)),
      latencyMs: elapsed,
    });
  }
  return out;
}

// ----- summary stats -----

function recallAt(stats: PerQueryResult[], k: number): number {
  if (stats.length === 0) return 0;
  return stats.filter((s) => s.rankOfExpected >= 0 && s.rankOfExpected < k).length / stats.length;
}

function mrr(stats: PerQueryResult[]): number {
  if (stats.length === 0) return 0;
  return stats.reduce((acc, s) => acc + (s.rankOfExpected >= 0 ? 1 / (s.rankOfExpected + 1) : 0), 0) / stats.length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function topKAgreement(a: PerQueryResult[], b: PerQueryResult[], k: number): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    const setA = new Set(a[i].topIds.slice(0, k));
    const setB = new Set(b[i].topIds.slice(0, k));
    let overlap = 0;
    for (const id of setA) if (setB.has(id)) overlap++;
    total += overlap / k;
  }
  return total / a.length;
}

const fmt = (n: number, digits = 2) => n.toFixed(digits);
const pct = (n: number, digits = 1) => `${(n * 100).toFixed(digits)}%`;

// ----- benchmark one embedder -----

interface EmbedderRun {
  id: string;
  label: string;
  tier: 'small' | 'base' | 'large' | 'cloud';
  model: string;
  dimensions: number;
  approxOnnxMb?: number;
  ingest: IngestStats;
  throughput: ThroughputPoint[];
  memoryMB: { modelResident: number; queryOverhead: number };
  queries: PerQueryResult[];
}

async function benchmarkOne(
  meta: { id: string; label: string; tier: EmbedderRun['tier']; approxOnnxMb?: number },
  embedderFactory: () => Embedder,
  chunks: Chunk[],
  queries: GeneratedQuery[],
  batchSizes: number[],
): Promise<EmbedderRun> {
  const validQueries = queries.filter((q) => q.text !== null);
  const pre = memSnapshot();
  const embedder = embedderFactory();
  console.error(`\n[${meta.id}] ${meta.label} dim=${embedder.dimensions} model=${embedder.model}`);

  await embedder.embed('warmup');
  const afterLoad = memSnapshot();

  const db = await create({ embedder, storageDriver: createMemoryDriver() });
  const ingest = await ingestAll(db, chunks);
  console.error(`  ingest:    ${fmt(ingest.totalMs)} ms total (${fmt(ingest.chunksPerSec)} chunks/s)`);

  const throughput = await measureThroughput(embedder, chunks.map((c) => c.text), batchSizes);
  for (const t of throughput) {
    console.error(`  batch=${String(t.batchSize).padStart(3)}: ${fmt(t.perItemMs)} ms/item (${fmt(t.itemsPerSec)} items/s)`);
  }

  console.error(`  running ${validQueries.length} queries…`);
  const perQuery = await runQueries(db, validQueries);
  const afterRun = memSnapshot();

  await db.close();

  const memoryMB = {
    modelResident: toMB(afterLoad.rss - pre.rss),
    queryOverhead: toMB(afterRun.rss - afterLoad.rss),
  };
  console.error(`  memory:    model resident ${memoryMB.modelResident} MB, working-set delta ${memoryMB.queryOverhead} MB`);

  return {
    id: meta.id,
    label: meta.label,
    tier: meta.tier,
    model: embedder.model ?? 'unknown',
    dimensions: embedder.dimensions,
    approxOnnxMb: meta.approxOnnxMb,
    ingest,
    throughput,
    memoryMB,
    queries: perQuery,
  };
}

// ----- main -----

interface RunSummary {
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  latencyMs: { p50: number; p95: number };
}

function summarize(run: EmbedderRun): RunSummary {
  const latencies = run.queries.map((q) => q.latencyMs);
  return {
    recallAt1: recallAt(run.queries, 1),
    recallAt3: recallAt(run.queries, 3),
    recallAt5: recallAt(run.queries, 5),
    recallAt10: recallAt(run.queries, 10),
    mrr: mrr(run.queries),
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
  };
}

function tierTable(runs: EmbedderRun[]): string {
  const lines = [
    '| Tier | Model | Size | Recall@1 | Recall@5 | MRR | p50 latency |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const r of runs) {
    const s = summarize(r);
    const size = r.tier === 'cloud' ? 'cloud' : r.approxOnnxMb ? `${r.approxOnnxMb} MB` : '–';
    lines.push(
      `| ${r.tier} | ${r.label} | ${size} | ${pct(s.recallAt1)} | ${pct(s.recallAt5)} | ${fmt(s.mrr, 3)} | ${fmt(s.latencyMs.p50)} ms |`,
    );
  }
  return lines.join('\n');
}

function detailSection(run: EmbedderRun): string {
  const s = summarize(run);
  const sizeLabel = run.tier === 'cloud' ? 'n/a (cloud)' : run.approxOnnxMb ? `${run.approxOnnxMb} MB` : '–';
  return [
    `### ${run.label} (${run.model}, ${run.dimensions}d, ${sizeLabel})`,
    '',
    `- Ingest (all chunks, batches of ${INGEST_BATCH}): ${fmt(run.ingest.totalMs)} ms (${fmt(run.ingest.chunksPerSec)} chunks/s)`,
    `- Throughput: ` + run.throughput.map((t) => `batch=${t.batchSize}: ${fmt(t.perItemMs)} ms/item`).join('; '),
    `- Memory: model resident ${run.memoryMB.modelResident} MB`,
    `- Recall@1 ${pct(s.recallAt1)} · Recall@3 ${pct(s.recallAt3)} · Recall@5 ${pct(s.recallAt5)} · Recall@10 ${pct(s.recallAt10)}`,
    `- MRR: ${fmt(s.mrr, 3)}`,
    `- Query latency: median ${fmt(s.latencyMs.p50)} ms, p95 ${fmt(s.latencyMs.p95)} ms`,
    '',
  ].join('\n');
}

async function main() {
  console.error(`Loading corpus…`);
  const { fileName, chunks } = await loadCorpus();
  console.error(`Corpus: ${chunks.length} chunks from ${fileName}`);

  const generated = await generateOrLoadQueries(
    chunks.map((c) => ({ id: c.id, text: c.text })),
    {
      apiKey: OPENAI_API_KEY,
      model: QUERY_MODEL,
      queriesPerChunk: QUERIES_PER_CHUNK,
      cachePath: QUERIES_CACHE_PATH,
      regenerate: REGENERATE_QUERIES,
      promptVersion: 1,
    },
  );
  const validQueryCount = generated.filter((q) => q.text !== null).length;
  console.error(`Queries: ${validQueryCount} valid (of ${generated.length} generated)`);

  // Pick which models to run.
  const targetModels = MODEL_FILTER ? BENCH_MODELS.filter((m) => MODEL_FILTER.has(m.id)) : BENCH_MODELS;

  // Pre-fetch all weights so any download errors surface before we start timing.
  for (const spec of targetModels) {
    await ensureModelDownloaded(spec);
  }

  const runs: EmbedderRun[] = [];
  for (const spec of targetModels) {
    const run = await benchmarkOne(
      { id: spec.id, label: spec.label, tier: spec.tier, approxOnnxMb: spec.approxOnnxMb },
      () => createBenchEmbedder(spec, modelDir(spec)),
      chunks,
      generated,
      BATCH_SIZES,
    );
    runs.push(run);
  }

  let openaiRun: EmbedderRun | null = null;
  if (!SKIP_OPENAI && OPENAI_API_KEY) {
    openaiRun = await benchmarkOne(
      { id: 'openai-text-embedding-3-small', label: 'text-embedding-3-small', tier: 'cloud' },
      () => createOpenAIEmbedder({ apiKey: OPENAI_API_KEY }),
      chunks,
      generated,
      BATCH_SIZES,
    );
    runs.push(openaiRun);
  } else {
    console.error('\n[openai] skipped (no OPENAI_API_KEY or SKIP_OPENAI=1)');
  }

  // Cross-embedder agreement: edge models vs OpenAI (if present).
  const agreement: Record<string, { top1: number; top5: number }> = {};
  if (openaiRun) {
    for (const run of runs) {
      if (run === openaiRun) continue;
      agreement[run.id] = {
        top1: topKAgreement(run.queries, openaiRun.queries, 1),
        top5: topKAgreement(run.queries, openaiRun.queries, 5),
      };
    }
  }

  // JSON artifact.
  const results = {
    metadata: {
      timestamp: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      corpus: { fileName, chunkCount: chunks.length },
      queries: { count: validQueryCount, generated: generated.length, source: 'llm-generated', model: QUERY_MODEL, queriesPerChunk: QUERIES_PER_CHUNK },
      batchSizes: BATCH_SIZES,
    },
    runs: runs.map((r) => ({ ...r, summary: summarize(r) })),
    agreement,
  };
  writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2) + '\n');
  console.error(`\nWrote structured results to ${RESULTS_PATH}`);

  // Markdown summary.
  const lines: string[] = [];
  lines.push('# embedder benchmark v3');
  lines.push('');
  lines.push(`Corpus: ${chunks.length} chunks from \`${fileName}\` · Queries: ${validQueryCount} (LLM-paraphrased, ${QUERY_MODEL})`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(tierTable(runs));
  lines.push('');
  if (openaiRun) {
    lines.push('## Cross-embedder agreement vs OpenAI');
    lines.push('');
    lines.push('| Model | Top-1 overlap | Top-5 overlap |');
    lines.push('|---|---|---|');
    for (const run of runs) {
      if (run === openaiRun) continue;
      const a = agreement[run.id];
      lines.push(`| ${run.label} | ${pct(a.top1)} | ${pct(a.top5)} |`);
    }
    lines.push('');
  }
  lines.push('## Per-model detail');
  lines.push('');
  for (const run of runs) lines.push(detailSection(run));
  console.log(lines.join('\n'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
