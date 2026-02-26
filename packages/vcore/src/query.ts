import type { VCoreInstance, QueryParams, QueryResult } from './types.js';
import { validateEmbedding, compareIds } from './validation.js';

export function query(instance: VCoreInstance, params: QueryParams): QueryResult[] {
  validateEmbedding(params.vector, instance.config.dimensions);

  const topK = params.topK ?? 10;
  const filter = params.filter;

  // Quantize the query vector
  const quantizedQuery = instance.codec.encode(params.vector);

  const results: QueryResult[] = [];

  for (const [, entry] of instance.entries) {
    if (filter && !filter(entry.context)) continue;

    const score = instance.similarityFn(quantizedQuery, entry.quantized);

    results.push({
      id: entry.id,
      score,
      context: entry.context,
    });
  }

  // Sort descending by score, tie-break by lower ID first
  results.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (scoreDiff !== 0) return scoreDiff;
    return compareIds(a.id, b.id);
  });

  return results.slice(0, topK);
}
