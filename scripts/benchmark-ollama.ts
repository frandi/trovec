#!/usr/bin/env npx tsx

/**
 * Ollama Benchmark Script
 *
 * Benchmarks LLM and embedding models running in the local Ollama Docker container.
 * Supports comparing multiple LLM models side-by-side.
 *
 * Usage:
 *   npx tsx scripts/benchmark-ollama.ts
 *
 * Environment:
 *   OLLAMA_HOST    — Ollama base URL (default: http://localhost:11434)
 *   ITERATIONS     — Number of iterations per benchmark (default: 5)
 *   LLM_MODELS     — Comma-separated LLM models to benchmark (default: llama3.2:1b,llama3.2:3b)
 *   EMBED_MODEL    — Embedding model to benchmark (default: nomic-embed-text)
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const ITERATIONS = Number(process.env.ITERATIONS ?? 5);
const LLM_MODELS = (process.env.LLM_MODELS ?? 'llama3.2:1b,llama3.2:3b').split(',').map(s => s.trim());
const EMBED_MODEL = process.env.EMBED_MODEL ?? 'nomic-embed-text';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Stats {
  avg: number;
  min: number;
  max: number;
  p95: number;
}

interface BenchResult {
  label: string;
  stats: Stats;
  extra: string;
}

function computeStats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return {
    avg: sum / sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p95: sorted[p95Index],
  };
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(1)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function fmtRow(label: string, stats: Stats, extra = ''): void {
  const row = [
    label.padEnd(32),
    fmtMs(stats.avg).padStart(12),
    fmtMs(stats.min).padStart(12),
    fmtMs(stats.max).padStart(12),
    fmtMs(stats.p95).padStart(12),
    extra.padStart(16),
  ].join('│');
  console.log(`│${row}│`);
}

function printHeader(title: string): void {
  console.log();
  console.log(`${'═'.repeat(100)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(100)}`);
  const hdr = [
    'Test'.padEnd(32),
    'Avg'.padStart(12),
    'Min'.padStart(12),
    'Max'.padStart(12),
    'P95'.padStart(12),
    'Extra'.padStart(16),
  ].join('│');
  console.log(`│${hdr}│`);
  console.log(`│${'─'.repeat(32)}│${'─'.repeat(12)}│${'─'.repeat(12)}│${'─'.repeat(12)}│${'─'.repeat(12)}│${'─'.repeat(16)}│`);
}

function printDivider(): void {
  console.log(`│${'─'.repeat(100)}│`);
}

function generateWords(count: number): string {
  const words = [
    'the', 'quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog',
    'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing',
    'artificial', 'intelligence', 'machine', 'learning', 'neural', 'network',
    'vector', 'database', 'embedding', 'similarity', 'search', 'quantum',
    'computing', 'algorithm', 'optimization', 'distributed', 'system', 'cloud',
  ];
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    result.push(words[i % words.length]);
  }
  return result.join(' ');
}

// ---------------------------------------------------------------------------
// Ollama API helpers
// ---------------------------------------------------------------------------

interface GenerateResult {
  response: string;
  totalDuration: number;
  evalCount: number;
  evalDuration: number;
  promptEvalDuration: number;
}

async function ollamaGenerate(
  model: string,
  prompt: string,
  opts: { stream?: boolean; numPredict?: number } = {},
): Promise<GenerateResult> {
  const res = await fetch(`${BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: opts.stream ?? false,
      options: { num_predict: opts.numPredict ?? 100 },
    }),
  });

  if (!res.ok) throw new Error(`Ollama generate failed: ${res.status}`);

  if (opts.stream) {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let firstChunkTime = 0;
    const startTime = performance.now();
    let fullResponse = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (!firstChunkTime && text.trim()) {
        firstChunkTime = performance.now() - startTime;
      }
      for (const line of text.split('\n').filter(Boolean)) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.done) {
            fullResponse = parsed.response ?? fullResponse;
          }
        } catch { /* partial chunk */ }
      }
    }

    return {
      response: fullResponse,
      totalDuration: performance.now() - startTime,
      evalCount: 0,
      evalDuration: 0,
      promptEvalDuration: firstChunkTime,
    };
  }

  const data = await res.json();
  return {
    response: data.response,
    totalDuration: data.total_duration / 1e6,
    evalCount: data.eval_count ?? 0,
    evalDuration: data.eval_duration ? data.eval_duration / 1e6 : 0,
    promptEvalDuration: data.prompt_eval_duration ? data.prompt_eval_duration / 1e6 : 0,
  };
}

async function ollamaEmbed(input: string | string[]): Promise<{ embeddings: number[][]; durationMs: number }> {
  const start = performance.now();
  const res = await fetch(`${BASE_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input }),
  });

  if (!res.ok) throw new Error(`Ollama embed failed: ${res.status}`);

  const data = await res.json();
  return {
    embeddings: data.embeddings,
    durationMs: performance.now() - start,
  };
}

// ---------------------------------------------------------------------------
// LLM Benchmarks (per model)
// ---------------------------------------------------------------------------

async function benchLlmForModel(model: string): Promise<BenchResult[]> {
  const results: BenchResult[] = [];

  // 1. Generate ~100 tokens
  {
    const durations: number[] = [];
    const tokensPerSec: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const result = await ollamaGenerate(model, 'Write a short story about a robot discovering nature.', { numPredict: 100 });
      durations.push(result.totalDuration);
      if (result.evalCount > 0 && result.evalDuration > 0) {
        tokensPerSec.push((result.evalCount / result.evalDuration) * 1000);
      }
    }
    const stats = computeStats(durations);
    const tps = tokensPerSec.length > 0 ? (tokensPerSec.reduce((a, b) => a + b, 0) / tokensPerSec.length).toFixed(1) : 'N/A';
    results.push({ label: 'Generate ~100 tokens', stats, extra: `${tps} tok/s` });
  }

  // 2. Time to first token (streaming)
  {
    const durations: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const result = await ollamaGenerate(model, 'Tell me a joke.', { stream: true, numPredict: 50 });
      durations.push(result.promptEvalDuration);
    }
    results.push({ label: 'Time to first token (stream)', stats: computeStats(durations), extra: '' });
  }

  // 3. Varying prompt lengths
  const sizes: [string, number][] = [
    ['Short prompt (10 words)', 10],
    ['Medium prompt (100 words)', 100],
    ['Long prompt (500 words)', 500],
  ];
  for (const [label, wordCount] of sizes) {
    const prompt = generateWords(wordCount) + '\n\nSummarize the above in one sentence.';
    const durations: number[] = [];
    const promptEvalDurations: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const result = await ollamaGenerate(model, prompt, { numPredict: 30 });
      durations.push(result.totalDuration);
      if (result.promptEvalDuration > 0) {
        promptEvalDurations.push(result.promptEvalDuration);
      }
    }
    const stats = computeStats(durations);
    const avgPromptEval = promptEvalDurations.length > 0
      ? fmtMs(promptEvalDurations.reduce((a, b) => a + b, 0) / promptEvalDurations.length)
      : 'N/A';
    results.push({ label, stats, extra: `peval ${avgPromptEval}` });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Embedding Benchmarks
// ---------------------------------------------------------------------------

async function benchEmbedding(): Promise<void> {
  printHeader(`Embedding Benchmarks — ${EMBED_MODEL}`);

  // Single embed
  {
    const durations: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const result = await ollamaEmbed('The quick brown fox jumps over the lazy dog.');
      durations.push(result.durationMs);
    }
    fmtRow('Single text embed', computeStats(durations));
  }

  // Batch embed
  {
    const texts = Array.from({ length: 10 }, (_, i) => `This is sample text number ${i + 1} for batch embedding benchmark.`);
    const durations: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const result = await ollamaEmbed(texts);
      durations.push(result.durationMs);
    }
    const stats = computeStats(durations);
    fmtRow('Batch embed (10 texts)', stats, `${(10 / (stats.avg / 1000)).toFixed(1)} emb/s`);
  }

  // Text size scaling
  const sizes: [string, number][] = [
    ['Embed 10 words', 10],
    ['Embed 50 words', 50],
    ['Embed 200 words', 200],
    ['Embed 500 words', 500],
  ];
  for (const [label, wordCount] of sizes) {
    const text = generateWords(wordCount);
    const durations: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const result = await ollamaEmbed(text);
      durations.push(result.durationMs);
    }
    fmtRow(label, computeStats(durations));
  }

  // Throughput
  {
    const text = 'A short sentence for throughput measurement.';
    const count = 20;
    const start = performance.now();
    for (let i = 0; i < count; i++) {
      await ollamaEmbed(text);
    }
    const elapsed = performance.now() - start;
    const throughput = (count / elapsed) * 1000;
    const perReq = elapsed / count;
    const stats: Stats = { avg: perReq, min: perReq, max: perReq, p95: perReq };
    fmtRow(`Throughput (${count} sequential)`, stats, `${throughput.toFixed(1)} emb/s`);
  }

  printDivider();
}

// ---------------------------------------------------------------------------
// Comparison Table
// ---------------------------------------------------------------------------

function printComparison(modelResults: Map<string, BenchResult[]>): void {
  const models = [...modelResults.keys()];
  if (models.length < 2) return;

  console.log();
  console.log(`${'═'.repeat(100)}`);
  console.log(`  LLM Comparison Summary`);
  console.log(`${'═'.repeat(100)}`);

  // Build comparison header
  const colW = Math.floor(60 / models.length);
  const hdr = [
    'Metric'.padEnd(28),
    ...models.map(m => m.padStart(colW)),
    'Delta'.padStart(12),
  ].join('│');
  console.log(`│${hdr}│`);
  console.log(`│${'─'.repeat(28)}│${models.map(() => '─'.repeat(colW)).join('│')}│${'─'.repeat(12)}│`);

  // For each test, compare across models
  const firstResults = modelResults.get(models[0])!;
  for (let i = 0; i < firstResults.length; i++) {
    const label = firstResults[i].label;
    const avgs = models.map(m => modelResults.get(m)![i].stats.avg);

    // Delta: compare last model vs first model
    const ratio = avgs[avgs.length - 1] / avgs[0];
    const deltaStr = ratio > 1
      ? `${ratio.toFixed(2)}x slower`
      : `${(1 / ratio).toFixed(2)}x faster`;

    const row = [
      label.padEnd(28),
      ...avgs.map(a => fmtMs(a).padStart(colW)),
      deltaStr.padStart(12),
    ].join('│');
    console.log(`│${row}│`);
  }

  // tok/s comparison
  const tpsValues = models.map(m => {
    const genResult = modelResults.get(m)![0];
    return genResult.extra;
  });
  const tpsRow = [
    'Tokens/sec'.padEnd(28),
    ...tpsValues.map(t => t.padStart(colW)),
    ''.padStart(12),
  ].join('│');
  console.log(`│${'─'.repeat(28)}│${models.map(() => '─'.repeat(colW)).join('│')}│${'─'.repeat(12)}│`);
  console.log(`│${tpsRow}│`);

  console.log(`│${'─'.repeat(28)}│${models.map(() => '─'.repeat(colW)).join('│')}│${'─'.repeat(12)}│`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║          Ollama Benchmark — VCore                       ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Host:       ${BASE_URL.padEnd(42)}║`);
  console.log(`║  LLM:        ${LLM_MODELS.join(', ').padEnd(42)}║`);
  console.log(`║  Embedder:   ${EMBED_MODEL.padEnd(42)}║`);
  console.log(`║  Iterations: ${String(ITERATIONS).padEnd(42)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  // Check connectivity
  try {
    const res = await fetch(`${BASE_URL}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    console.error(`\n❌ Cannot reach Ollama at ${BASE_URL}. Is the container running?\n`);
    process.exit(1);
  }

  const modelResults = new Map<string, BenchResult[]>();

  // ── LLM Benchmarks (per model) ──────────────────────────────────────────
  for (const model of LLM_MODELS) {
    process.stdout.write(`⏳ Warming up ${model}...`);
    await ollamaGenerate(model, 'Hi', { numPredict: 5 });
    console.log(' done.');

    printHeader(`LLM Benchmarks — ${model}`);
    const results = await benchLlmForModel(model);
    for (const r of results) {
      fmtRow(r.label, r.stats, r.extra);
    }
    printDivider();
    modelResults.set(model, results);
  }

  // ── Comparison Table ─────────────────────────────────────────────────────
  printComparison(modelResults);

  // ── Embedding Benchmarks ─────────────────────────────────────────────────
  process.stdout.write(`⏳ Warming up ${EMBED_MODEL}...`);
  await ollamaEmbed('warmup');
  console.log(' done.');

  await benchEmbedding();

  console.log('\n✅ Benchmark complete.\n');
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
