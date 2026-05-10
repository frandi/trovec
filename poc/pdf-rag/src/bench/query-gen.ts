// LLM-driven paraphrased query generator for the embedder benchmark.
//
// For each chunk in the corpus, prompt OpenAI to write one question that the
// chunk answers — paraphrased, not copying the chunk's wording. Validate each
// generated query (length, word-trigram overlap with the source) and retry on
// failure. Cache the result to bench-queries.json keyed by a corpus
// fingerprint so subsequent runs are deterministic and free.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import OpenAI from 'openai';

export interface CorpusChunk {
  id: string;
  text: string;
}

export interface GeneratedQuery {
  id: string;
  expectedChunkId: string;
  text: string | null;
  skipped?: string;
}

export interface QueryGenOptions {
  apiKey: string;
  model: string;
  queriesPerChunk: number;
  cachePath: string;
  regenerate: boolean;
  promptVersion: number;
  maxRetries?: number;
  /** Max word-trigram fraction of query that may overlap with source. */
  maxOverlap?: number;
  log?: (msg: string) => void;
}

interface CacheFile {
  version: 1;
  corpusFingerprint: string;
  queriesPerChunk: number;
  generator: { model: string; promptVersion: number };
  generatedAt: string;
  queries: GeneratedQuery[];
}

const FORBIDDEN_PREFIXES = [
  'what does the passage say',
  'according to the passage',
  'in this passage',
  'the passage says',
];

function fingerprint(chunks: CorpusChunk[]): string {
  const ids = chunks.map((c) => c.id).sort().join('\n');
  return createHash('sha256').update(ids).digest('hex');
}

function wordTrigrams(s: string): Set<string> {
  const words = s
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= words.length; i++) {
    grams.add(words.slice(i, i + 3).join(' '));
  }
  return grams;
}

function queryOverlap(query: string, source: string): number {
  const q = wordTrigrams(query);
  if (q.size === 0) return 0;
  const s = wordTrigrams(source);
  let hits = 0;
  for (const g of q) if (s.has(g)) hits++;
  return hits / q.size;
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function validate(question: string, source: string, maxOverlap: number): { ok: true } | { ok: false; reason: string } {
  const lower = question.toLowerCase().trim();
  for (const p of FORBIDDEN_PREFIXES) {
    if (lower.startsWith(p)) return { ok: false, reason: `starts with forbidden prefix: ${p}` };
  }
  const wc = wordCount(question);
  if (wc < 10 || wc > 30) return { ok: false, reason: `word count ${wc} outside 10-30` };
  const overlap = queryOverlap(question, source);
  if (overlap > maxOverlap) return { ok: false, reason: `trigram overlap ${overlap.toFixed(2)} > ${maxOverlap}` };
  return { ok: true };
}

const PROMPT_V1 = (chunkText: string) => `Read this passage from a document. Write ONE specific question that the passage directly answers, with these requirements:

- The answer must be findable from this passage alone.
- Use different words than the passage. Do not copy phrases verbatim.
- Be specific enough that an unrelated passage wouldn't answer it.
- Length: 10 to 30 words.
- Do not start with "What does the passage say" or "According to the passage".

Passage:
"""
${chunkText}
"""

Respond with only the question, no preamble.`;

async function generateOne(
  client: OpenAI,
  model: string,
  chunk: CorpusChunk,
  promptVersion: number,
  maxRetries: number,
  maxOverlap: number,
  log: (msg: string) => void,
): Promise<{ text: string | null; skipped?: string }> {
  if (promptVersion !== 1) throw new Error(`Unknown prompt version: ${promptVersion}`);
  const prompt = PROMPT_V1(chunk.text);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const resp = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
    });
    const candidate = resp.choices[0]?.message?.content?.trim() ?? '';
    if (!candidate) {
      log(`  ${chunk.id} attempt ${attempt + 1}: empty response`);
      continue;
    }
    const v = validate(candidate, chunk.text, maxOverlap);
    if (v.ok) return { text: candidate };
    log(`  ${chunk.id} attempt ${attempt + 1}: rejected — ${v.reason}`);
  }
  return { text: null, skipped: 'validation_failed_after_retries' };
}

function loadCache(path: string): CacheFile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as CacheFile;
  } catch {
    return null;
  }
}

function saveCache(path: string, data: CacheFile): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Returns one or more generated queries per chunk, using the cache when valid.
 * Side effect: writes the cache file when regenerating.
 */
export async function generateOrLoadQueries(
  chunks: CorpusChunk[],
  options: QueryGenOptions,
): Promise<GeneratedQuery[]> {
  const log = options.log ?? ((msg) => console.error(msg));
  const fp = fingerprint(chunks);

  const cache = loadCache(options.cachePath);
  if (
    !options.regenerate &&
    cache &&
    cache.corpusFingerprint === fp &&
    cache.generator.model === options.model &&
    cache.generator.promptVersion === options.promptVersion &&
    cache.queriesPerChunk === options.queriesPerChunk
  ) {
    const valid = cache.queries.filter((q) => q.text !== null);
    log(`[queries] reused ${valid.length} cached queries (skipped ${cache.queries.length - valid.length})`);
    return cache.queries;
  }

  if (!options.apiKey) {
    throw new Error(
      'No OPENAI_API_KEY set and no compatible queries cache found. ' +
      'Either provide an API key for query generation or copy a pre-generated bench-queries.json.',
    );
  }

  log(`[queries] generating ${chunks.length * options.queriesPerChunk} queries via ${options.model}…`);
  const client = new OpenAI({ apiKey: options.apiKey });

  const queries: GeneratedQuery[] = [];
  let qIdx = 0;
  for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
    const chunk = chunks[cIdx];
    for (let r = 0; r < options.queriesPerChunk; r++) {
      const result = await generateOne(
        client,
        options.model,
        chunk,
        options.promptVersion,
        options.maxRetries ?? 3,
        options.maxOverlap ?? 0.5,
        log,
      );
      const q: GeneratedQuery = {
        id: `q-${qIdx++}`,
        expectedChunkId: chunk.id,
        text: result.text,
      };
      if (result.skipped) q.skipped = result.skipped;
      queries.push(q);
    }
    if ((cIdx + 1) % 10 === 0) {
      log(`[queries] ${cIdx + 1}/${chunks.length} chunks processed`);
    }
  }

  const cacheData: CacheFile = {
    version: 1,
    corpusFingerprint: fp,
    queriesPerChunk: options.queriesPerChunk,
    generator: { model: options.model, promptVersion: options.promptVersion },
    generatedAt: new Date().toISOString(),
    queries,
  };
  saveCache(options.cachePath, cacheData);

  const valid = queries.filter((q) => q.text !== null);
  log(`[queries] generated ${valid.length} valid (skipped ${queries.length - valid.length}); cached to ${options.cachePath}`);
  return queries;
}
