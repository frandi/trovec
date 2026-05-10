import { LiteParse } from '@llamaindex/liteparse';
import type { Trovec } from '@trovec/core';

const MIN_CHUNK_LENGTH = 100;
const MAX_CHUNK_LENGTH = 500;
// Bound peak memory and give per-batch progress hooks. Mirrors the
// rationale at poc/pdf-rag/src/benchmark.ts INGEST_BATCH.
const INGEST_BATCH = 32;

export interface IngestResult {
  fileName: string;
  totalPages: number;
  totalChunks: number;
}

interface Chunk {
  text: string;
  pageNumber: number;
}

function chunkPage(pageText: string, pageNumber: number): Chunk[] {
  const paragraphs = pageText.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return [];

  const chunks: Chunk[] = [];
  let buffer = '';

  for (const para of paragraphs) {
    if (buffer.length + para.length > MAX_CHUNK_LENGTH && buffer.length >= MIN_CHUNK_LENGTH) {
      chunks.push({ text: buffer.trim(), pageNumber });
      buffer = '';
    }
    buffer += (buffer ? '\n\n' : '') + para;
  }

  if (buffer.trim().length > 0) {
    chunks.push({ text: buffer.trim(), pageNumber });
  }

  return chunks;
}

export async function ingestPdf(
  db: Trovec,
  filePath: string,
  fileName: string,
): Promise<IngestResult> {
  const startedAt = Date.now();
  console.log(`[ingest] ${fileName}: parsing PDF…`);

  const parser = new LiteParse({ ocrEnabled: false });
  const result = await parser.parse(filePath);

  const totalPages = result.pages.length;

  const allChunks: Chunk[] = [];
  for (const page of result.pages) {
    const trimmed = page.text.trim();
    if (trimmed.length === 0) continue;
    allChunks.push(...chunkPage(trimmed, page.pageNum));
  }

  const entries = allChunks.map((chunk, i) => ({
    id: `${fileName}:p${chunk.pageNumber}:c${i}`,
    text: chunk.text,
    context: {
      pageNumber: chunk.pageNumber,
      sourceFile: fileName,
      fullText: chunk.text,
      preview: chunk.text.slice(0, 200),
      totalPages,
    },
  }));

  console.log(
    `[ingest] ${fileName}: embedding ${entries.length} chunks across ${totalPages} pages…`,
  );

  for (let i = 0; i < entries.length; i += INGEST_BATCH) {
    const slice = entries.slice(i, i + INGEST_BATCH);
    await db.addManyWithText(slice);
    const done = Math.min(i + INGEST_BATCH, entries.length);
    console.log(`[ingest] ${fileName}: embedded ${done}/${entries.length} chunks`);
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[ingest] ${fileName}: done — ${entries.length} chunks across ${totalPages} pages in ${elapsedSec}s`,
  );

  return {
    fileName,
    totalPages,
    totalChunks: entries.length,
  };
}
